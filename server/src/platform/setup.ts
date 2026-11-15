import type { AirwallexClient } from '../airwallex/client';
import type { Database } from '../db/client';
import { AppError } from '../lib/errors';
import { LeveeClient, LeveeError } from '../levee/client';
import type { LeveeTenant } from '../levee/types';
import { savePlatformCredentials, type PlatformCredentials } from './platform';

export interface SetupInput {
  readonly leveePlatformKey: string;
  readonly leveeTenantId: string;
  readonly airwallexClientId: string;
  readonly airwallexApiKey: string;
  readonly webhookSecret: string;
}

export interface SetupReport {
  readonly leveePlatformId: string;
  readonly tenantName: string | null;
  readonly rpId: string;
  readonly addedOrigin: boolean;
  readonly warnings: readonly string[];
}

export interface SetupDependencies {
  readonly db: Database;
  readonly encryptionKey: Buffer;
  readonly publicUrl: string;
  readonly leveeApiUrl: string;
  readonly leveeConsoleOrigin: string;
  readonly airwallex: AirwallexClient;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

const FORMATS: ReadonlyArray<readonly [keyof SetupInput, RegExp, string]> = [
  ['leveePlatformKey', /^sk_test_[A-Za-z0-9_-]{8,256}$/, 'The Levee platform key is a sandbox key starting sk_test_'],
  ['leveeTenantId', /^ten_[A-Za-z0-9_-]{1,128}$/, 'The Levee tenant id starts with ten_'],
  ['airwallexClientId', /^[A-Za-z0-9_-]{8,128}$/, 'The Airwallex client ID looks wrong'],
  ['airwallexApiKey', /^[A-Za-z0-9_-]{16,512}$/, 'The Airwallex API key looks wrong'],
  ['webhookSecret', /^whsec_[A-Za-z0-9_-]{8,256}$/, 'The Levee webhook signing secret starts with whsec_'],
];

function checkFormats(input: SetupInput): void {
  for (const [field, pattern, message] of FORMATS) {
    if (!pattern.test(input[field])) throw new AppError(400, 'invalid_setup', message);
  }
}

function leveeFailure(error: unknown, action: string): AppError {
  if (error instanceof LeveeError && (error.status === 401 || error.status === 403)) {
    return new AppError(401, 'levee_auth_failed', `Levee rejected the platform key while ${action}.`);
  }
  return new AppError(502, 'levee_unreachable', `Levee could not be reached while ${action}.`);
}

/** The RP ID must be the app's host or a parent domain of it, or browsers refuse the passkey. */
function rpCovers(rpId: string, publicUrl: string): boolean {
  const host = new URL(publicUrl).hostname;
  return host === rpId || host.endsWith(`.${rpId}`);
}

/**
 * Checks the operator's credentials against Levee and Airwallex, then stores them encrypted.
 * Levee: the key names its platform, the platform owns the tenant, and the tenant is a sandbox
 * consumer program whose passkey origins include this app (added when missing).
 * Airwallex: the keys sign in and can use the Connected Account APIs.
 */
export async function runSetup(deps: SetupDependencies, input: SetupInput): Promise<SetupReport> {
  checkFormats(input);
  const levee = new LeveeClient({
    baseUrl: deps.leveeApiUrl,
    platformKey: input.leveePlatformKey,
    tenantId: input.leveeTenantId,
    consoleOrigin: deps.leveeConsoleOrigin,
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
  });

  let platformId: unknown;
  try {
    ({ id: platformId } = await levee.get<{ id?: unknown }>('/v1/platforms/me'));
  } catch (error) {
    throw leveeFailure(error, 'reading its platform');
  }
  if (typeof platformId !== 'string' || platformId.length === 0) {
    throw new AppError(502, 'levee_unreachable', 'Levee did not return the platform for this key.');
  }

  let tenants: unknown;
  try {
    tenants = await levee.get<unknown>(`/v1/platforms/${encodeURIComponent(platformId)}/tenants`);
  } catch (error) {
    throw leveeFailure(error, 'listing its tenants');
  }
  const list = Array.isArray(tenants) ? (tenants as LeveeTenant[]) : [];
  const tenant = list.find((entry) => entry.id === input.leveeTenantId);
  if (tenant === undefined)
    throw new AppError(403, 'levee_tenant_mismatch', 'This platform key does not own that tenant.');
  if (tenant.environment !== 'test') throw new AppError(403, 'levee_tenant_mismatch', 'Use a sandbox (test) tenant.');
  if (tenant.program_type !== 'consumer') {
    throw new AppError(403, 'levee_tenant_mismatch', 'Acme Pay needs a consumer program tenant.');
  }
  const rpId = tenant.webauthn?.rpId;
  if (rpId === undefined || rpId.length === 0) {
    throw new AppError(
      409,
      'levee_rp_missing',
      'Set the tenant passkey relying party (RP ID) in the Levee console first.',
    );
  }

  const origins = tenant.webauthn?.origins ?? [];
  const addedOrigin = !origins.includes(deps.publicUrl);
  if (addedOrigin) {
    const path = `/v1/platforms/${encodeURIComponent(platformId)}/tenants/${encodeURIComponent(tenant.id)}/webauthn`;
    try {
      await levee.patch(path, { rp_id: rpId, origins: [...origins, deps.publicUrl] });
    } catch (error) {
      throw leveeFailure(error, 'adding this app to the tenant passkey origins');
    }
  }

  const airwallex = { clientId: input.airwallexClientId, apiKey: input.airwallexApiKey };
  await deps.airwallex.verify(airwallex);

  const credentials: PlatformCredentials = {
    leveePlatformId: platformId,
    leveeTenantId: tenant.id,
    leveePlatformKey: input.leveePlatformKey,
    airwallex,
    webhookSecret: input.webhookSecret,
  };
  await savePlatformCredentials(deps.db, deps.encryptionKey, credentials, deps.now?.() ?? new Date());

  const warnings = rpCovers(rpId, deps.publicUrl)
    ? []
    : [`The tenant RP ID ${rpId} does not cover ${deps.publicUrl}; passkeys will fail until they match.`];
  return { leveePlatformId: platformId, tenantName: tenant.display_name ?? null, rpId, addedOrigin, warnings };
}

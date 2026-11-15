import webpush from 'web-push';
import type { AirwallexClient } from '../airwallex/client';
import type { Database } from '../db/client';
import { AppError } from '../lib/errors';
import { LeveeClient, LeveeError } from '../levee/client';
import type { LeveeTenant } from '../levee/types';
import { savePlatformCredentials, storedVapidKeys, type PlatformCredentials } from './platform';

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
  /** The RP ID the tenant had before, when setup replaced a different one. */
  readonly previousRpId: string | null;
  /** True when the tenant's passkey settings were written (RP ID or origins changed). */
  readonly updatedWebauthn: boolean;
  readonly origins: readonly string[];
  /** True when setup generated a new Web Push key pair (none was stored yet). */
  readonly generatedVapid: boolean;
  readonly warnings: readonly string[];
}

/** What the operator is asked before setup replaces the tenant's RP ID. */
export interface RpIdChange {
  readonly from: string;
  readonly to: string;
}

export interface SetupDependencies {
  readonly db: Database;
  readonly encryptionKey: Buffer;
  readonly publicUrl: string;
  readonly leveeApiUrl: string;
  readonly leveeConsoleOrigin: string;
  readonly airwallex: AirwallexClient;
  /** ACME_PASSKEY_RP_ID: a registrable suffix of the public URL's host, or null for the host itself. */
  readonly passkeyRpIdOverride?: string | null;
  /**
   * Called before replacing a different RP ID on the tenant, since passkeys registered under the old
   * one stop working. Return true to go ahead. Without it, a different RP ID is refused.
   */
  readonly confirmRpIdChange?: (change: RpIdChange) => Promise<boolean>;
  /**
   * False leaves the tenant's passkey settings alone: `npm run dev` points them at each run's tunnel
   * itself. Default true.
   */
  readonly managePasskeys?: boolean;
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
    // Local development registers its own webhook endpoint, so the operator's secret may be blank.
    if (field === 'webhookSecret' && input.webhookSecret === '') continue;
    if (!pattern.test(input[field])) throw new AppError(400, 'invalid_setup', message);
  }
}

function leveeFailure(error: unknown, action: string): AppError {
  if (error instanceof LeveeError && (error.status === 401 || error.status === 403)) {
    return new AppError(401, 'levee_auth_failed', `Levee rejected the platform key while ${action}.`);
  }
  return new AppError(502, 'levee_unreachable', `Levee could not be reached while ${action}.`);
}

const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * Shared hosting suffixes where every customer gets a subdomain. They are public suffixes, so
 * browsers refuse them as an RP ID; the app's own subdomain has to be the RP ID instead.
 */
const SHARED_SUFFIXES: readonly string[] = [
  'trycloudflare.com',
  'pages.dev',
  'workers.dev',
  'ngrok.io',
  'ngrok.app',
  'ngrok-free.app',
  'vercel.app',
  'netlify.app',
  'github.io',
  'herokuapp.com',
  'onrender.com',
  'fly.dev',
];

/**
 * The passkey RP ID for an app served at `publicUrl`: its host, or `override` when that is a
 * registrable suffix of the host (`pay.example.com` may use `example.com`). Follows Levee's rules
 * for a tenant RP ID: a bare hostname, never an IP address. Levee also refuses localhost on
 * production tenants; that is Levee's call, so it is not checked here.
 */
export function derivePasskeyRpId(publicUrl: string, override?: string | null): string {
  const host = new URL(publicUrl).hostname.toLowerCase();
  if (IPV4.test(host) || host.startsWith('[')) {
    throw new AppError(
      400,
      'invalid_rp_id',
      `Passkeys need a hostname, not an IP address. Open the app at a hostname (localhost or a domain) instead of ${host}.`,
    );
  }
  const candidate = override?.trim().toLowerCase().replace(/\.$/, '') ?? '';
  if (candidate === '') return host;
  if (candidate.length > 253 || !HOSTNAME.test(candidate) || IPV4.test(candidate)) {
    throw new AppError(
      400,
      'invalid_rp_id',
      'ACME_PASSKEY_RP_ID must be a bare hostname, with no scheme, port or path.',
    );
  }
  if (host !== candidate && !host.endsWith(`.${candidate}`)) {
    throw new AppError(
      400,
      'invalid_rp_id',
      `ACME_PASSKEY_RP_ID ${candidate} must be ${host} or a parent domain of it.`,
    );
  }
  const publicSuffix = (!candidate.includes('.') && candidate !== 'localhost') || SHARED_SUFFIXES.includes(candidate);
  if (publicSuffix) {
    throw new AppError(
      400,
      'invalid_rp_id',
      `ACME_PASSKEY_RP_ID ${candidate} is a public suffix that browsers refuse as an RP ID; use ${host}.`,
    );
  }
  return candidate;
}

/**
 * Checks the operator's credentials against Levee and Airwallex, then stores them encrypted.
 * Levee: the key names its platform, the platform owns the tenant, and the tenant is a sandbox
 * consumer program. Setup sets the tenant's passkey RP ID to this app's host (or ACME_PASSKEY_RP_ID)
 * and its origins to this app's origin, asking first when that replaces a different RP ID.
 * Push: a Web Push (VAPID) key pair is generated once and stored encrypted.
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
  const managePasskeys = deps.managePasskeys ?? true;
  const currentRpId = tenant.webauthn?.rpId ?? '';
  const currentOrigins = tenant.webauthn?.origins ?? [];
  const rpId = managePasskeys ? derivePasskeyRpId(deps.publicUrl, deps.passkeyRpIdOverride) : currentRpId;
  // Android app origins are not web origins and do not depend on the RP ID host; they are kept.
  const apps = currentOrigins.filter((entry) => entry.startsWith('android:'));
  const origins = managePasskeys ? [deps.publicUrl, ...apps] : [...currentOrigins];
  const previousRpId = currentRpId !== '' && currentRpId.toLowerCase() !== rpId ? currentRpId : null;
  if (previousRpId !== null) {
    const confirmed = (await deps.confirmRpIdChange?.({ from: previousRpId, to: rpId })) ?? false;
    if (!confirmed) {
      throw new AppError(
        409,
        'rp_id_change_not_confirmed',
        `The tenant passkey RP ID is ${previousRpId}; this app needs ${rpId}. Passkeys registered under ${previousRpId} stop working after the change. Run setup again and confirm, or pass --force-rp-id.`,
      );
    }
  }
  const updatedWebauthn =
    currentRpId.toLowerCase() !== rpId ||
    currentOrigins.length !== origins.length ||
    currentOrigins.some((entry, i) => entry !== origins[i]);
  if (updatedWebauthn) {
    const path = `/v1/platforms/${encodeURIComponent(platformId)}/tenants/${encodeURIComponent(tenant.id)}/webauthn`;
    try {
      await levee.patch(path, { rp_id: rpId, origins });
    } catch (error) {
      if (error instanceof LeveeError && error.status === 400) {
        const local =
          rpId === 'localhost'
            ? ' Levee does not allow localhost on this tenant; serve the app on a public HTTPS URL (npm run dev:tunnel) and run setup there.'
            : '';
        throw new AppError(
          400,
          'levee_rp_refused',
          `Levee refused RP ID ${rpId} with origin ${deps.publicUrl}: ${error.message}.${local}`,
        );
      }
      throw leveeFailure(error, 'setting the tenant passkey RP ID and origins');
    }
  }

  const airwallex = { clientId: input.airwallexClientId, apiKey: input.airwallexApiKey };
  await deps.airwallex.verify(airwallex);
  // Kept across runs: a new key pair would silently invalidate every phone's subscription.
  const existingVapid = await storedVapidKeys(deps.db, deps.encryptionKey);

  const credentials: PlatformCredentials = {
    leveePlatformId: platformId,
    leveeTenantId: tenant.id,
    leveePlatformKey: input.leveePlatformKey,
    airwallex,
    webhookSecret: input.webhookSecret,
    vapid: existingVapid ?? webpush.generateVAPIDKeys(),
  };
  await savePlatformCredentials(
    deps.db,
    deps.encryptionKey,
    credentials,
    deps.now?.() ?? new Date(),
    rpId === '' ? null : rpId,
  );

  const warnings = deps.publicUrl.startsWith('https:')
    ? []
    : [`Phone notifications need a public HTTPS URL; ${deps.publicUrl} only works on this computer.`];
  return {
    leveePlatformId: platformId,
    tenantName: tenant.display_name ?? null,
    rpId,
    previousRpId,
    updatedWebauthn,
    origins,
    generatedVapid: existingVapid === null,
    warnings,
  };
}

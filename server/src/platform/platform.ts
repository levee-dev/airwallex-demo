import { eq } from 'drizzle-orm';
import type { AppConfig } from '../config';
import type { Database } from '../db/client';
import { platformConfig } from '../db/schema';
import type { AirwallexKeys } from '../airwallex/client';
import { decryptSecret, encryptSecret, last4 } from '../lib/crypto';
import { AppError } from '../lib/errors';
import { LeveeClient } from '../levee/client';

export interface PlatformCredentials {
  readonly leveePlatformId: string;
  readonly leveeTenantId: string;
  readonly leveePlatformKey: string;
  readonly airwallex: AirwallexKeys;
  readonly webhookSecret: string;
  /** Web Push key pair; null on a configuration saved before push existed. */
  readonly vapid: VapidKeyPair | null;
}

export interface VapidKeyPair {
  readonly publicKey: string;
  readonly privateKey: string;
}

/** The Levee webhook endpoint `npm run dev` registered, with its signing secret. */
export interface RegisteredWebhookEndpoint {
  readonly id: string;
  readonly url: string;
  readonly secret: string;
}

/** Public view of the stored configuration: identifiers and last four characters only. */
export interface PlatformSummary {
  readonly leveePlatformId: string;
  readonly leveeTenantId: string;
  readonly leveePlatformKeyLast4: string;
  readonly airwallexClientId: string;
  readonly airwallexApiKeyLast4: string;
  readonly webhookSecretLast4: string;
  readonly verifiedAt: Date;
  readonly lastWebhookAt: Date | null;
  readonly webhookEndpointId: string | null;
  readonly webhookEndpointUrl: string | null;
  readonly webhookEndpointSecretLast4: string | null;
  readonly webhookEndpointRegisteredAt: Date | null;
  readonly passkeyRpId: string | null;
  /** Not a secret: browsers subscribe with it. Null when push is not configured. */
  readonly vapidPublicKey: string | null;
}

export async function savePlatformCredentials(
  db: Database,
  key: Buffer,
  credentials: PlatformCredentials,
  verifiedAt: Date,
  passkeyRpId: string | null = null,
): Promise<void> {
  const row = {
    leveePlatformId: credentials.leveePlatformId,
    leveeTenantId: credentials.leveeTenantId,
    leveePlatformKey: encryptSecret(credentials.leveePlatformKey, key),
    leveePlatformKeyLast4: last4(credentials.leveePlatformKey),
    airwallexClientId: credentials.airwallex.clientId,
    airwallexApiKey: encryptSecret(credentials.airwallex.apiKey, key),
    airwallexApiKeyLast4: last4(credentials.airwallex.apiKey),
    webhookSecret: encryptSecret(credentials.webhookSecret, key),
    webhookSecretLast4: last4(credentials.webhookSecret),
    vapidPublicKey: credentials.vapid?.publicKey ?? null,
    vapidPrivateKey: credentials.vapid === null ? null : encryptSecret(credentials.vapid.privateKey, key),
    passkeyRpId,
    verifiedAt,
  };
  await db
    .insert(platformConfig)
    .values({ id: 1, ...row })
    .onConflictDoUpdate({ target: platformConfig.id, set: row });
}

/** Records the RP ID the tenant's passkeys now use, for `acme status`. */
export async function savePasskeyRpId(db: Database, rpId: string): Promise<void> {
  await db.update(platformConfig).set({ passkeyRpId: rpId }).where(eq(platformConfig.id, 1));
}

/** The stored Web Push key pair, if any. Setup keeps it across runs so subscriptions stay valid. */
export async function storedVapidKeys(db: Database, key: Buffer): Promise<VapidKeyPair | null> {
  const [row] = await db
    .select({ publicKey: platformConfig.vapidPublicKey, privateKey: platformConfig.vapidPrivateKey })
    .from(platformConfig)
    .where(eq(platformConfig.id, 1));
  if (row === undefined || row.publicKey === null || row.privateKey === null) return null;
  return { publicKey: row.publicKey, privateKey: decryptSecret(row.privateKey, key) };
}

export async function platformSummary(db: Database): Promise<PlatformSummary | null> {
  const [row] = await db.select().from(platformConfig).where(eq(platformConfig.id, 1));
  if (row === undefined) return null;
  return {
    leveePlatformId: row.leveePlatformId,
    leveeTenantId: row.leveeTenantId,
    leveePlatformKeyLast4: row.leveePlatformKeyLast4,
    airwallexClientId: row.airwallexClientId,
    airwallexApiKeyLast4: row.airwallexApiKeyLast4,
    webhookSecretLast4: row.webhookSecretLast4,
    verifiedAt: row.verifiedAt,
    lastWebhookAt: row.lastWebhookAt,
    webhookEndpointId: row.webhookEndpointId,
    webhookEndpointUrl: row.webhookEndpointUrl,
    webhookEndpointSecretLast4: row.webhookEndpointSecretLast4,
    webhookEndpointRegisteredAt: row.webhookEndpointRegisteredAt,
    passkeyRpId: row.passkeyRpId,
    vapidPublicKey: row.vapidPublicKey,
  };
}

/** The endpoint last registered by `npm run dev`, or null when there is none. */
export async function savedWebhookEndpoint(db: Database, key: Buffer): Promise<RegisteredWebhookEndpoint | null> {
  const [row] = await db.select().from(platformConfig).where(eq(platformConfig.id, 1));
  if (row?.webhookEndpointId == null || row.webhookEndpointUrl === null || row.webhookEndpointSecret === null) {
    return null;
  }
  return {
    id: row.webhookEndpointId,
    url: row.webhookEndpointUrl,
    secret: decryptSecret(row.webhookEndpointSecret, key),
  };
}

/** Stores the registered endpoint; its secret is encrypted like every other credential. */
export async function saveWebhookEndpoint(
  db: Database,
  key: Buffer,
  endpoint: RegisteredWebhookEndpoint,
  registeredAt: Date,
): Promise<void> {
  const updated = await db
    .update(platformConfig)
    .set({
      webhookEndpointId: endpoint.id,
      webhookEndpointUrl: endpoint.url,
      webhookEndpointSecret: encryptSecret(endpoint.secret, key),
      webhookEndpointSecretLast4: last4(endpoint.secret),
      webhookEndpointRegisteredAt: registeredAt,
    })
    .where(eq(platformConfig.id, 1))
    .returning({ id: platformConfig.id });
  if (updated.length === 0) {
    throw new AppError(503, 'platform_not_configured', 'Acme Pay is not set up yet. Run `npm run setup` first.');
  }
}

/**
 * The operator's platform credentials, read from the database on every use so a new `acme setup`
 * takes effect without a restart. The Levee client is reused while the credentials are unchanged,
 * which keeps its CSRF token cache warm.
 */
export class Platform {
  private cached: { readonly stamp: string; readonly client: LeveeClient } | null = null;

  constructor(
    private readonly db: Database,
    private readonly config: Pick<AppConfig, 'encryptionKey' | 'leveeApiUrl' | 'leveeConsoleOrigin'>,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async credentials(): Promise<PlatformCredentials & { readonly webhookSecrets: readonly string[] }> {
    const [row] = await this.db.select().from(platformConfig).where(eq(platformConfig.id, 1));
    if (row === undefined) {
      throw new AppError(
        503,
        'platform_not_configured',
        'Acme Pay is not set up yet. The operator runs `npm run setup`.',
      );
    }
    const key = this.config.encryptionKey;
    const webhookSecret = decryptSecret(row.webhookSecret, key);
    const endpointSecret = row.webhookEndpointSecret === null ? null : decryptSecret(row.webhookEndpointSecret, key);
    return {
      leveePlatformId: row.leveePlatformId,
      leveeTenantId: row.leveeTenantId,
      leveePlatformKey: decryptSecret(row.leveePlatformKey, key),
      airwallex: { clientId: row.airwallexClientId, apiKey: decryptSecret(row.airwallexApiKey, key) },
      webhookSecret,
      // Deliveries are signed with the secret of the endpoint they were sent to: the one entered at
      // setup, or the one `npm run dev` registered. Either verifies.
      webhookSecrets: [webhookSecret, endpointSecret].filter(
        (secret): secret is string => secret !== null && secret !== '',
      ),
      vapid:
        row.vapidPublicKey === null || row.vapidPrivateKey === null
          ? null
          : { publicKey: row.vapidPublicKey, privateKey: decryptSecret(row.vapidPrivateKey, key) },
    };
  }

  async levee(): Promise<LeveeClient> {
    const credentials = await this.credentials();
    const stamp = `${credentials.leveeTenantId}:${credentials.leveePlatformKey}`;
    if (this.cached?.stamp !== stamp) {
      const client = new LeveeClient({
        baseUrl: this.config.leveeApiUrl,
        platformKey: credentials.leveePlatformKey,
        tenantId: credentials.leveeTenantId,
        consoleOrigin: this.config.leveeConsoleOrigin,
        fetch: this.fetchFn,
      });
      this.cached = { stamp, client };
    }
    return this.cached.client;
  }

  async recordWebhook(at: Date): Promise<void> {
    await this.db.update(platformConfig).set({ lastWebhookAt: at }).where(eq(platformConfig.id, 1));
  }
}

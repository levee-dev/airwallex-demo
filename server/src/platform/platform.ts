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
}

export async function savePlatformCredentials(
  db: Database,
  key: Buffer,
  credentials: PlatformCredentials,
  verifiedAt: Date,
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
    verifiedAt,
  };
  await db
    .insert(platformConfig)
    .values({ id: 1, ...row })
    .onConflictDoUpdate({ target: platformConfig.id, set: row });
}

export async function platformSummary(db: Database): Promise<PlatformSummary | null> {
  const [row] = await db.select().from(platformConfig).where(eq(platformConfig.id, 1));
  return row ?? null;
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

  async credentials(): Promise<PlatformCredentials> {
    const [row] = await this.db.select().from(platformConfig).where(eq(platformConfig.id, 1));
    if (row === undefined) {
      throw new AppError(
        503,
        'platform_not_configured',
        'Acme Pay is not set up yet. The operator runs `npm run setup`.',
      );
    }
    const key = this.config.encryptionKey;
    return {
      leveePlatformId: row.leveePlatformId,
      leveeTenantId: row.leveeTenantId,
      leveePlatformKey: decryptSecret(row.leveePlatformKey, key),
      airwallex: { clientId: row.airwallexClientId, apiKey: decryptSecret(row.airwallexApiKey, key) },
      webhookSecret: decryptSecret(row.webhookSecret, key),
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

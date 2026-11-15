import { AirwallexClient } from '../src/airwallex/client';
import { loadConfig } from '../src/config';
import { connectDatabase, migrateDatabase } from '../src/db/client';
import { AppError } from '../src/lib/errors';
import { platformSummary } from '../src/platform/platform';
import { derivePasskeyRpId, runSetup } from '../src/platform/setup';
import { WEBHOOK_EVENT_TYPES } from '../src/webhooks/events';
import { runDev } from './dev';
import { confirmRpIdChange, readSetupInput } from './prompts';

/**
 * The operator CLI.
 *
 *   acme migrate   apply database migrations
 *   acme setup     store and verify the platform credentials (prompts, or reads ACME_SETUP_* env vars),
 *                  set the tenant passkey RP ID and origin, and generate the Web Push keys.
 *                  --force-rp-id replaces a different tenant RP ID without asking.
 *   acme status    show what is configured, without secrets
 *   acme dev       local development (`npm run dev`): checks Postgres, migrates, asks for missing
 *                  credentials, opens a Cloudflare quick tunnel and runs the dev servers.
 *                  `--no-tunnel` stays on localhost.
 */

async function setup(args: readonly string[]): Promise<void> {
  const config = loadConfig();
  const unknown = args.filter((arg) => arg !== '--force-rp-id');
  if (unknown.length > 0) throw new Error(`Unknown option ${unknown.join(' ')}. The only option is --force-rp-id.`);
  // Fails on a bad ACME_PASSKEY_RP_ID before asking for any credential.
  derivePasskeyRpId(config.publicUrl, config.passkeyRpId);
  const input = await readSetupInput();
  const database = connectDatabase(config.databaseUrl);
  try {
    const report = await runSetup(
      {
        db: database.db,
        encryptionKey: config.encryptionKey,
        publicUrl: config.publicUrl,
        leveeApiUrl: config.leveeApiUrl,
        leveeConsoleOrigin: config.leveeConsoleOrigin,
        airwallex: new AirwallexClient({ baseUrl: config.airwallexBaseUrl }),
        passkeyRpIdOverride: config.passkeyRpId,
        confirmRpIdChange: (change) => confirmRpIdChange(change, args.includes('--force-rp-id')),
      },
      input,
    );
    console.log(`\nVerified and saved.`);
    console.log(`  Levee platform  ${report.leveePlatformId}`);
    console.log(
      `  Tenant          ${input.leveeTenantId}${report.tenantName === null ? '' : ` (${report.tenantName})`}`,
    );
    console.log(
      `  Passkey RP ID   ${report.rpId} for ${report.origins.join(', ')}${report.previousRpId === null ? '' : ` (was ${report.previousRpId})`}${report.updatedWebauthn ? '' : ', unchanged'}`,
    );
    console.log(`  Phone push      ${report.generatedVapid ? 'VAPID keys generated' : 'existing VAPID keys kept'}`);
    for (const warning of report.warnings) console.log(`  Warning: ${warning}`);
    console.log(`\nIn the Levee console, the platform webhook endpoint must be ${config.publicUrl}/webhooks/levee`);
    console.log(`subscribed to: ${WEBHOOK_EVENT_TYPES.join(', ')}.`);
    console.log('For local development, `npm run dev` registers a public endpoint for you instead.');
  } finally {
    await database.close();
  }
}

function rpIdFor(publicUrl: string, override: string | null): string | null {
  try {
    return derivePasskeyRpId(publicUrl, override);
  } catch {
    return null;
  }
}

async function status(): Promise<void> {
  const config = loadConfig();
  const database = connectDatabase(config.databaseUrl);
  try {
    const summary = await platformSummary(database.db);
    if (summary === null) {
      console.log('Not set up. Run `npm run setup`.');
      return;
    }
    console.log(`Levee tenant       ${summary.leveeTenantId} (platform ${summary.leveePlatformId})`);
    console.log(`Levee key          …${summary.leveePlatformKeyLast4}`);
    console.log(`Airwallex client   ${summary.airwallexClientId}, key …${summary.airwallexApiKeyLast4}`);
    console.log(
      `Webhook secret     ${summary.webhookSecretLast4 === '' ? 'none (`npm run dev` uses its own endpoint)' : `…${summary.webhookSecretLast4}`}`,
    );
    console.log(`Passkey RP ID      ${summary.passkeyRpId ?? 'not set yet; run npm run setup'}`);
    const expected = rpIdFor(config.publicUrl, config.passkeyRpId);
    if (summary.passkeyRpId !== null && expected !== null && expected !== summary.passkeyRpId) {
      console.log(`  Note: ${config.publicUrl} needs RP ID ${expected}; npm run setup (or npm run dev) changes it.`);
    }
    console.log(
      `Phone push         ${summary.vapidPublicKey === null ? 'not configured; run npm run setup' : 'configured'}`,
    );
    console.log(`Verified           ${summary.verifiedAt.toISOString()}`);
    console.log(
      summary.webhookEndpointUrl === null
        ? 'Webhook endpoint   none registered (`npm run dev` registers one)'
        : `Webhook endpoint   ${summary.webhookEndpointUrl} (${summary.webhookEndpointId ?? ''}, secret …${summary.webhookEndpointSecretLast4 ?? ''}, registered ${summary.webhookEndpointRegisteredAt?.toISOString() ?? ''})`,
    );
    console.log(`Last webhook       ${summary.lastWebhookAt?.toISOString() ?? 'none yet'}`);
  } finally {
    await database.close();
  }
}

async function main(command: string | undefined, args: readonly string[]): Promise<void> {
  switch (command) {
    case 'migrate': {
      const url = process.env.DATABASE_URL?.trim();
      if (!url) throw new Error('DATABASE_URL is required');
      await migrateDatabase(url);
      console.log('Database is up to date.');
      return;
    }
    case 'setup':
      return setup(args);
    case 'status':
      return status();
    case 'dev':
      return runDev(process.argv.slice(3));
    default:
      console.log('Usage: acme <migrate|setup|status|dev>');
      process.exitCode = 1;
  }
}

main(process.argv[2], process.argv.slice(3)).catch((error: unknown) => {
  console.error(error instanceof AppError || error instanceof Error ? `Error: ${error.message}` : 'Error');
  process.exitCode = 1;
});

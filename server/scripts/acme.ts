import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { AirwallexClient } from '../src/airwallex/client';
import { loadConfig } from '../src/config';
import { connectDatabase, migrateDatabase } from '../src/db/client';
import { AppError } from '../src/lib/errors';
import { platformSummary } from '../src/platform/platform';
import { runSetup, type SetupInput } from '../src/platform/setup';
import { WEBHOOK_EVENT_TYPES } from '../src/webhooks/events';

/**
 * The operator CLI.
 *
 *   acme migrate   apply database migrations
 *   acme setup     store and verify the platform credentials (prompts, or reads ACME_SETUP_* env vars)
 *   acme status    show what is configured, without secrets
 */

const FIELDS: ReadonlyArray<{ key: keyof SetupInput; env: string; label: string; secret: boolean }> = [
  { key: 'leveeTenantId', env: 'ACME_SETUP_LEVEE_TENANT_ID', label: 'Levee tenant id (ten_…)', secret: false },
  {
    key: 'leveePlatformKey',
    env: 'ACME_SETUP_LEVEE_PLATFORM_KEY',
    label: 'Levee platform key (sk_test_…)',
    secret: true,
  },
  { key: 'airwallexClientId', env: 'ACME_SETUP_AIRWALLEX_CLIENT_ID', label: 'Airwallex client ID', secret: false },
  { key: 'airwallexApiKey', env: 'ACME_SETUP_AIRWALLEX_API_KEY', label: 'Airwallex API key', secret: true },
  {
    key: 'webhookSecret',
    env: 'ACME_SETUP_LEVEE_WEBHOOK_SECRET',
    label: 'Levee webhook signing secret (whsec_…)',
    secret: true,
  },
];

/** Reads one line without echoing it. */
function promptHidden(label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    stdout.write(`${label}: `);
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          stdout.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u0003') {
          stdin.setRawMode(false);
          reject(new Error('cancelled'));
          return;
        }
        value = char === '\u007f' ? value.slice(0, -1) : value + char;
      }
    };
    stdin.on('data', onData);
  });
}

async function readSetupInput(): Promise<SetupInput> {
  const values: Partial<Record<keyof SetupInput, string>> = {};
  const missing = FIELDS.filter((field) => {
    const fromEnv = process.env[field.env]?.trim();
    if (fromEnv) values[field.key] = fromEnv;
    return !fromEnv;
  });
  if (missing.length > 0 && !stdin.isTTY) {
    throw new Error(`Set ${missing.map((field) => field.env).join(', ')} or run setup in a terminal.`);
  }
  for (const field of missing) {
    if (field.secret) {
      values[field.key] = (await promptHidden(field.label)).trim();
    } else {
      const rl = createInterface({ input: stdin, output: stdout });
      values[field.key] = (await rl.question(`${field.label}: `)).trim();
      rl.close();
    }
  }
  return values as SetupInput;
}

async function setup(): Promise<void> {
  const config = loadConfig();
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
      },
      input,
    );
    console.log(`\nVerified and saved.`);
    console.log(`  Levee platform  ${report.leveePlatformId}`);
    console.log(
      `  Tenant          ${input.leveeTenantId}${report.tenantName === null ? '' : ` (${report.tenantName})`}`,
    );
    console.log(`  Passkey RP ID   ${report.rpId}${report.addedOrigin ? `, now allowing ${config.publicUrl}` : ''}`);
    for (const warning of report.warnings) console.log(`  Warning: ${warning}`);
    console.log(`\nIn the Levee console, the platform webhook endpoint must be ${config.publicUrl}/webhooks/levee`);
    console.log(`subscribed to: ${WEBHOOK_EVENT_TYPES.join(', ')}.`);
  } finally {
    await database.close();
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
    console.log(`Webhook secret     …${summary.webhookSecretLast4}`);
    console.log(`Verified           ${summary.verifiedAt.toISOString()}`);
    console.log(`Last webhook       ${summary.lastWebhookAt?.toISOString() ?? 'none yet'}`);
  } finally {
    await database.close();
  }
}

async function main(command: string | undefined): Promise<void> {
  switch (command) {
    case 'migrate': {
      const url = process.env.DATABASE_URL?.trim();
      if (!url) throw new Error('DATABASE_URL is required');
      await migrateDatabase(url);
      console.log('Database is up to date.');
      return;
    }
    case 'setup':
      return setup();
    case 'status':
      return status();
    default:
      console.log('Usage: acme <migrate|setup|status>');
      process.exitCode = 1;
  }
}

main(process.argv[2]).catch((error: unknown) => {
  console.error(error instanceof AppError || error instanceof Error ? `Error: ${error.message}` : 'Error');
  process.exitCode = 1;
});

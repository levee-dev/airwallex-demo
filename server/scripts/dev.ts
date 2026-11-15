import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { AirwallexClient } from '../src/airwallex/client';
import { loadConfig, type AppConfig } from '../src/config';
import { connectDatabase, migrateDatabase, type DatabaseHandle } from '../src/db/client';
import { LeveeClient } from '../src/levee/client';
import {
  Platform,
  platformSummary,
  savedWebhookEndpoint,
  savePasskeyRpId,
  saveWebhookEndpoint,
} from '../src/platform/platform';
import { runSetup } from '../src/platform/setup';
import { ensureWebhookEndpoint, webhookUrlFor } from '../src/webhooks/endpoint';
import { confirm, interactive, readSetupInput } from './prompts';
import { cloudflaredInstalled, CLOUDFLARED_INSTALL_HINT, pointPasskeysAt, startQuickTunnel } from './tunnel';

/** The Vite dev server; it serves the web app and proxies /api, /mcp and /webhooks to the server. */
const WEB_PORT = 5173;
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ENV_FILE = `${REPO_ROOT}.env`;
const POSTGRES_WAIT_MS = 60_000;
const READY_WAIT_MS = 60_000;

/** Environment `npm run dev` cannot start without. Returns the names that are missing. */
export function missingEnv(env: Readonly<Record<string, string | undefined>>): string[] {
  return ['DATABASE_URL', 'ACME_ENCRYPTION_KEY'].filter((name) => (env[name]?.trim() ?? '') === '');
}

/** The summary printed once everything is up. */
export function summaryBox(lines: readonly string[]): string {
  const width = Math.max(...lines.map((line) => line.length));
  const rule = '─'.repeat(width + 2);
  return [`┌${rule}┐`, ...lines.map((line) => `│ ${line.padEnd(width)} │`), `└${rule}┘`].join('\n');
}

function step(text: string): void {
  console.log(`✓ ${text}`);
}

/** Step 0: a `.env` with a database URL and an encryption key, created on request. */
async function ensureEnv(): Promise<void> {
  const missing = missingEnv(process.env);
  if (missing.length === 0) return;
  if (!interactive()) {
    throw new Error(`Missing ${missing.join(', ')}. Copy .env.example to .env and set them (see the comments there).`);
  }
  if (!existsSync(ENV_FILE)) {
    if (!(await confirm('No .env yet. Create one from .env.example with a new encryption key?', true))) {
      throw new Error(`Missing ${missing.join(', ')}.`);
    }
    copyFileSync(`${REPO_ROOT}.env.example`, ENV_FILE);
  }
  const text = readFileSync(ENV_FILE, 'utf8');
  if (missing.includes('ACME_ENCRYPTION_KEY') && /^ACME_ENCRYPTION_KEY=\s*$/m.test(text)) {
    const key = randomBytes(32).toString('base64');
    writeFileSync(ENV_FILE, text.replace(/^ACME_ENCRYPTION_KEY=\s*$/m, `ACME_ENCRYPTION_KEY=${key}`));
    step('Generated ACME_ENCRYPTION_KEY in .env');
  }
  process.loadEnvFile(ENV_FILE);
  const still = missingEnv(process.env);
  if (still.length > 0) throw new Error(`Set ${still.join(', ')} in .env.`);
}

async function postgresReachable(url: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3_000 });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

function where(url: string): string {
  const parsed = new URL(url);
  return `${parsed.hostname}:${parsed.port || '5432'}`;
}

/** Step 1: Postgres, started with Docker Compose on request. */
async function ensurePostgres(url: string): Promise<void> {
  if (await postgresReachable(url)) {
    step(`Postgres at ${where(url)}`);
    return;
  }
  const hint = `Postgres is not reachable at ${where(url)}. Start it with \`docker compose up -d db\`.`;
  if (!interactive()) throw new Error(hint);
  if (
    !(await confirm(`Postgres is not reachable at ${where(url)}. Start it with \`docker compose up -d db\`?`, true))
  ) {
    throw new Error(hint);
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn('docker', ['compose', 'up', '-d', 'db'], { cwd: REPO_ROOT, stdio: 'inherit' });
    child.once('error', () => {
      reject(new Error('Docker is not installed or not running. Start Postgres yourself and set DATABASE_URL.'));
    });
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error('`docker compose up -d db` failed.'));
    });
  });
  const deadline = Date.now() + POSTGRES_WAIT_MS;
  while (!(await postgresReachable(url))) {
    if (Date.now() > deadline) throw new Error(`Postgres did not come up at ${where(url)} within a minute.`);
    await sleep(1_000);
  }
  step(`Postgres at ${where(url)}`);
}

/** Step 3: the platform credentials, asked for only when none are stored. */
async function ensurePlatform(config: AppConfig, database: DatabaseHandle): Promise<void> {
  if ((await platformSummary(database.db)) !== null) {
    step('Levee and Airwallex credentials');
    return;
  }
  console.log('Acme Pay needs your Levee sandbox and Airwallex sandbox credentials (stored encrypted).');
  const input = await readSetupInput({ optional: ['webhookSecret'], command: 'npm run dev' });
  const report = await runSetup(
    {
      db: database.db,
      encryptionKey: config.encryptionKey,
      publicUrl: config.publicUrl,
      leveeApiUrl: config.leveeApiUrl,
      leveeConsoleOrigin: config.leveeConsoleOrigin,
      airwallex: new AirwallexClient({ baseUrl: config.airwallexBaseUrl }),
      // The tunnel step points the tenant's passkeys at this run's URL.
      managePasskeys: false,
    },
    input,
  );
  step(`Levee and Airwallex credentials verified and saved (platform ${report.leveePlatformId})`);
}

/** Step 4: whether to run with a tunnel. Default on; without cloudflared, asks (or fails in CI). */
async function wantTunnel(args: readonly string[]): Promise<boolean> {
  if (args.includes('--no-tunnel')) return false;
  if (await cloudflaredInstalled()) return true;
  console.log(CLOUDFLARED_INSTALL_HINT);
  if (!interactive()) throw new Error('cloudflared is missing. Install it, or run `npm run dev -- --no-tunnel`.');
  if (await confirm('Continue without a tunnel (localhost only, no Levee webhooks)?', false)) return false;
  throw new Error('Install cloudflared and run `npm run dev` again.');
}

interface TunnelRun {
  readonly origin: string;
  readonly child: ChildProcess;
  readonly webhook: string;
  readonly staleTunnelEndpoints: number;
}

/** Step 4: the tunnel, the webhook endpoint for it and the tenant's passkey domain. */
async function openTunnel(config: AppConfig, database: DatabaseHandle): Promise<TunnelRun> {
  const tunnel = await startQuickTunnel(`http://localhost:${WEB_PORT}`);
  try {
    step(`Cloudflare quick tunnel ${tunnel.origin}`);
    const credentials = await new Platform(database.db, config).credentials();
    const levee = new LeveeClient({
      baseUrl: config.leveeApiUrl,
      platformKey: credentials.leveePlatformKey,
      tenantId: credentials.leveeTenantId,
      consoleOrigin: config.leveeConsoleOrigin,
    });
    const saved = await savedWebhookEndpoint(database.db, config.encryptionKey);
    const result = await ensureWebhookEndpoint(levee, credentials.leveePlatformId, webhookUrlFor(tunnel.origin), saved);
    if (result.registered) {
      await saveWebhookEndpoint(database.db, config.encryptionKey, result.endpoint, new Date());
    }
    step(`Levee webhook endpoint ${result.registered ? 'registered' : 'reused'} (${result.endpoint.id})`);
    await pointPasskeysAt(levee, credentials.leveePlatformId, credentials.leveeTenantId, tunnel.origin);
    await savePasskeyRpId(database.db, new URL(tunnel.origin).hostname);
    step(`Passkey domain ${new URL(tunnel.origin).hostname}`);
    return {
      origin: tunnel.origin,
      child: tunnel.child,
      webhook: result.endpoint.id,
      staleTunnelEndpoints: result.staleTunnelEndpoints,
    };
  } catch (error) {
    tunnel.child.kill();
    throw error;
  }
}

const WINDOWS = process.platform === 'win32';

/** Stops a child and everything it started (npm runs the dev servers as grandchildren). */
function terminate(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (!WINDOWS && child.pid !== undefined) process.kill(-child.pid, 'SIGTERM');
    else child.kill();
  } catch {
    child.kill();
  }
}

/** Runs a dev server in its own process group, with its output prefixed by name. */
function startDevServer(name: string, env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn('npm', ['run', 'dev', '-w', name], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: WINDOWS,
    detached: !WINDOWS,
  });
  const relay = (write: (text: string) => void) => (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) if (line.trim().length > 0) write(`[${name}] ${line}\n`);
  };
  child.stdout?.on(
    'data',
    relay((text) => process.stdout.write(text)),
  );
  child.stderr?.on(
    'data',
    relay((text) => process.stderr.write(text)),
  );
  return child;
}

async function waitForHttp(url: string): Promise<boolean> {
  const deadline = Date.now() + READY_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.status < 500) return true;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  return false;
}

/**
 * `npm run dev`: the one command for local development and demos. It checks each prerequisite in
 * order and asks only for what is missing (nothing at all without a terminal), then serves the whole
 * app on a Cloudflare quick tunnel origin, or on localhost with `--no-tunnel`.
 */
export async function runDev(args: readonly string[]): Promise<void> {
  await ensureEnv();
  const base = loadConfig();
  await ensurePostgres(base.databaseUrl);
  await migrateDatabase(base.databaseUrl);
  step('Database migrated');

  const database = connectDatabase(base.databaseUrl);
  const children: ChildProcess[] = [];
  let stopping: Promise<void> | null = null;
  const stop = () => {
    stopping ??= (async () => {
      for (const child of children) terminate(child);
      await database.close();
    })();
    return stopping;
  };
  process.once('exit', () => {
    for (const child of children) terminate(child);
  });

  let lines: string[];
  try {
    await ensurePlatform(base, database);
    const tunnel = (await wantTunnel(args)) ? await openTunnel(base, database) : null;
    if (tunnel !== null) children.push(tunnel.child);
    const publicUrl = tunnel?.origin ?? base.publicUrl;

    const env = { ...process.env, ACME_PUBLIC_URL: publicUrl, ACME_SERVER_URL: `http://127.0.0.1:${base.port}` };
    children.push(startDevServer('server', env), startDevServer('web', env));
    const ready = await Promise.all([
      waitForHttp(`http://127.0.0.1:${base.port}/api/health`),
      waitForHttp(`http://localhost:${WEB_PORT}/`),
    ]);
    if (!ready.every(Boolean)) throw new Error('The dev servers did not start; see their output above.');

    lines =
      tunnel === null
        ? [
            `Open Acme at ${publicUrl}`,
            'Webhooks  ✗ off: Levee cannot reach localhost (drop --no-tunnel to turn them on)',
            `MCP       ${publicUrl}/mcp`,
          ]
        : [
            `Open Acme at ${publicUrl}`,
            `Webhooks  ✓ ${publicUrl}/webhooks/levee`,
            `Passkeys  ${new URL(publicUrl).hostname}`,
            `MCP       ${publicUrl}/mcp`,
            '',
            'Open the same URL on your phone to demo approvals there.',
            'The URL changes every run, and passkeys are tied to it: after a',
            'restart, sign up again or add a new passkey. Ctrl-C stops everything.',
            ...(tunnel.staleTunnelEndpoints > 0
              ? [
                  `${tunnel.staleTunnelEndpoints} webhook endpoint(s) from earlier runs stay registered with Levee;`,
                  'their deliveries fail until Levee’s retry window ends.',
                ]
              : []),
          ];
  } catch (error) {
    await stop();
    throw error;
  }
  console.log(`\n${summaryBox(lines)}\n`);

  await new Promise<void>((resolve) => {
    const shutdown = () => void stop().then(resolve);
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    for (const child of children) {
      child.once('exit', (code, signal) => {
        if (stopping !== null) return;
        if (signal === null && code !== 0) process.exitCode = 1;
        console.error('A dev process stopped; shutting everything down.');
        shutdown();
      });
    }
  });
}

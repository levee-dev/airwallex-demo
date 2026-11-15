import { parseEncryptionKey } from './lib/crypto';

export const AIRWALLEX_SANDBOX_HOSTS = ['api-demo.airwallex.com', 'api.sandbox.airwallex.com'] as const;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface DecisionModelConfig {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
  readonly timeoutMs: number;
}

export interface AppConfig {
  readonly databaseUrl: string;
  readonly encryptionKey: Buffer;
  /** The browser origin of the web app. Approval links, the MCP URL and passkey origins derive from it. */
  readonly publicUrl: string;
  /** ACME_PASSKEY_RP_ID: optional parent domain of the public URL's host to use as the passkey RP ID. */
  readonly passkeyRpId: string | null;
  readonly host: string;
  readonly port: number;
  readonly production: boolean;
  readonly trustProxy: boolean;
  readonly leveeApiUrl: string;
  readonly leveeConsoleOrigin: string;
  readonly airwallexBaseUrl: string;
  readonly decisionModel: DecisionModelConfig | null;
}

type Env = Readonly<Record<string, string | undefined>>;

function value(env: Env, name: string): string | undefined {
  const raw = env[name]?.trim();
  return raw === undefined || raw.length === 0 ? undefined : raw;
}

function required(env: Env, name: string): string {
  const raw = value(env, name);
  if (raw === undefined) throw new Error(`${name} is required`);
  return raw;
}

/** An origin (scheme, host, port) with no path, query or credentials. */
function origin(raw: string, name: string, allowLoopbackHttp: boolean): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be a URL`);
  }
  const loopbackHttp = allowLoopbackHttp && url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !loopbackHttp) throw new Error(`${name} must use https`);
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error(`${name} must be an origin, with no path, query or credentials`);
  }
  return url.origin;
}

function decisionModel(env: Env): DecisionModelConfig | null {
  const apiKey = value(env, 'SYSTEM_ONE_API_KEY');
  if (apiKey === undefined) return null;
  const timeoutMs = Number(value(env, 'SYSTEM_ONE_TIMEOUT_MS') ?? '4000');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15_000) {
    throw new Error('SYSTEM_ONE_TIMEOUT_MS must be an integer from 100 to 15000');
  }
  return {
    baseUrl: origin(required(env, 'SYSTEM_ONE_BASE_URL'), 'SYSTEM_ONE_BASE_URL', true),
    model: required(env, 'SYSTEM_ONE_MODEL'),
    apiKey,
    timeoutMs,
  };
}

/** Reads and validates the environment. Error messages name the variable, never its value. */
export function loadConfig(env: Env = process.env): AppConfig {
  const production = env.NODE_ENV === 'production';
  const port = Number(value(env, 'PORT') ?? '8787');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PORT must be a TCP port');
  const leveeApiUrl = origin(value(env, 'LEVEE_API_URL') ?? 'https://sandbox.levee.dev', 'LEVEE_API_URL', !production);
  const airwallexBaseUrl = origin(
    value(env, 'AIRWALLEX_BASE_URL') ?? 'https://api-demo.airwallex.com',
    'AIRWALLEX_BASE_URL',
    false,
  );
  if (!(AIRWALLEX_SANDBOX_HOSTS as readonly string[]).includes(new URL(airwallexBaseUrl).hostname)) {
    throw new Error('AIRWALLEX_BASE_URL must be an Airwallex sandbox host');
  }
  return {
    databaseUrl: required(env, 'DATABASE_URL'),
    encryptionKey: parseEncryptionKey(env.ACME_ENCRYPTION_KEY),
    publicUrl: origin(value(env, 'ACME_PUBLIC_URL') ?? 'http://localhost:5173', 'ACME_PUBLIC_URL', true),
    passkeyRpId: value(env, 'ACME_PASSKEY_RP_ID') ?? null,
    host: value(env, 'HOST') ?? '127.0.0.1',
    port,
    production,
    trustProxy: value(env, 'TRUST_PROXY') === 'true',
    leveeApiUrl,
    leveeConsoleOrigin: origin(value(env, 'LEVEE_CONSOLE_ORIGIN') ?? leveeApiUrl, 'LEVEE_CONSOLE_ORIGIN', !production),
    airwallexBaseUrl,
    decisionModel: decisionModel(env),
  };
}

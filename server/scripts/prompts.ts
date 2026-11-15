import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import type { RpIdChange, SetupInput } from '../src/platform/setup';

/** Prompts only make sense with a person at a terminal; otherwise everything comes from the environment. */
export function interactive(): boolean {
  return stdin.isTTY && stdout.isTTY;
}

export const SETUP_FIELDS: ReadonlyArray<{ key: keyof SetupInput; env: string; label: string; secret: boolean }> = [
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
export function promptHidden(label: string): Promise<string> {
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

export async function promptLine(label: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(label)).trim();
  } finally {
    rl.close();
  }
}

/** A yes/no question; an empty answer takes the default. */
export async function confirm(question: string, defaultYes: boolean): Promise<boolean> {
  const answer = (await promptLine(`${question} ${defaultYes ? '[Y/n]' : '[y/N]'} `)).toLowerCase();
  if (answer === '') return defaultYes;
  return answer === 'y' || answer === 'yes';
}

/**
 * The platform credentials from `ACME_SETUP_*` variables, prompting at a terminal for any that are
 * missing (secrets without echo). Without a terminal, a missing value is an error naming every
 * variable to set. Optional fields are read from the environment but never prompted for.
 */
export async function readSetupInput(
  options: { readonly optional?: readonly (keyof SetupInput)[]; readonly command: string } = {
    command: 'npm run setup',
  },
): Promise<SetupInput> {
  const optional = new Set(options.optional ?? []);
  const values: Partial<Record<keyof SetupInput, string>> = {};
  const missing = SETUP_FIELDS.filter((field) => {
    const fromEnv = process.env[field.env]?.trim();
    values[field.key] = fromEnv ?? '';
    return !fromEnv && !optional.has(field.key);
  });
  if (missing.length > 0 && !interactive()) {
    throw new Error(
      `Acme Pay is not set up. Set ${missing.map((field) => field.env).join(', ')} (see .env.example), or run \`${options.command}\` in a terminal to be asked for them.`,
    );
  }
  for (const field of missing) {
    values[field.key] = field.secret ? (await promptHidden(field.label)).trim() : await promptLine(`${field.label}: `);
  }
  return values as SetupInput;
}

/**
 * Replacing the tenant's RP ID orphans every passkey registered under the old one, so it is never
 * done silently: a terminal asks, anything else needs --force-rp-id.
 */
export async function confirmRpIdChange({ from, to }: RpIdChange, force: boolean): Promise<boolean> {
  if (force) return true;
  if (!interactive()) return false;
  console.log(`\nThe tenant passkey RP ID is ${from}. This app at its public URL needs ${to}.`);
  console.log(`Passkeys already registered under ${from} stop working: their owners add a new passkey.`);
  return confirm(`Change the RP ID to ${to}?`, false);
}

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { missingEnv, summaryBox } from '../../scripts/dev';
import { readSetupInput } from '../../scripts/prompts';
import { pointPasskeysAt } from '../../scripts/tunnel';
import { webhookSignatureHeader } from '../../src/levee/webhook-signature';
import { platformSummary, savedWebhookEndpoint, saveWebhookEndpoint } from '../../src/platform/platform';
import {
  ensureWebhookEndpoint,
  parseQuickTunnelUrl,
  webhookUrlFor,
  type WebhookEndpointApi,
} from '../../src/webhooks/endpoint';
import { WEBHOOK_EVENT_TYPES } from '../../src/webhooks/events';
import { runSetup } from '../../src/platform/setup';
import { TEST_PLATFORM_ID, TEST_TENANT_ID } from '../support/fake-levee';
import { Harness, PUBLIC_URL } from '../support/harness';

const CLOUDFLARED_LOG = `2030-01-15T12:00:00Z INF Thank you for trying Cloudflare Tunnel.
2030-01-15T12:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...
2030-01-15T12:00:01Z INF +--------------------------------------------------------------------------------------------+
2030-01-15T12:00:01Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
2030-01-15T12:00:01Z INF |  https://Gentle-River-Example-Test.trycloudflare.com                                       |
2030-01-15T12:00:01Z INF +--------------------------------------------------------------------------------------------+`;

describe('quick tunnel URL', () => {
  it('reads the tunnel origin from cloudflared output', () => {
    expect(parseQuickTunnelUrl(CLOUDFLARED_LOG)).toBe('https://gentle-river-example-test.trycloudflare.com');
  });

  it('ignores the API host and output without a tunnel yet', () => {
    expect(parseQuickTunnelUrl('INF Requesting new quick Tunnel on https://api.trycloudflare.com/tunnel')).toBeNull();
    expect(parseQuickTunnelUrl('INF Requesting new quick Tunnel on trycloudflare.com...')).toBeNull();
    expect(parseQuickTunnelUrl('http://plain-http-host.trycloudflare.com')).toBeNull();
  });

  it('builds the webhook URL and refuses plain http', () => {
    expect(webhookUrlFor('https://gentle-river-example-test.trycloudflare.com')).toBe(
      'https://gentle-river-example-test.trycloudflare.com/webhooks/levee',
    );
    expect(() => webhookUrlFor('http://localhost:8787')).toThrow(/https/);
  });
});

interface StoredEndpoint {
  id: string;
  url: string;
  events: string[];
  disabled_at?: string;
}

/** Levee's platform webhook endpoint routes: register (secret returned once) and list. */
class FakeEndpointApi implements WebhookEndpointApi {
  readonly endpoints: StoredEndpoint[] = [];
  readonly posts: unknown[] = [];
  answer: ((body: { url: string; events: string[] }) => unknown) | null = null;
  private counter = 0;

  get<T>(path: string): Promise<T> {
    expect(path).toBe(`/v1/platforms/${TEST_PLATFORM_ID}/webhook-endpoints`);
    return Promise.resolve(this.endpoints.map((endpoint) => ({ ...endpoint })) as T);
  }

  post<T>(path: string, body: unknown): Promise<T> {
    expect(path).toBe(`/v1/platforms/${TEST_PLATFORM_ID}/webhook-endpoints`);
    this.posts.push(body);
    const input = body as { url: string; events: string[] };
    if (this.answer !== null) return Promise.resolve(this.answer(input) as T);
    this.counter += 1;
    const endpoint = { id: `wpe_test_${this.counter}`, url: input.url, events: [...input.events] };
    this.endpoints.unshift(endpoint);
    return Promise.resolve({ ...endpoint, secret: `whsec_test_secret_${this.counter}` } as T);
  }
}

describe('webhook endpoint registration', () => {
  const first = 'https://gentle-river-example-test.trycloudflare.com/webhooks/levee';
  const second = 'https://quiet-hill-example-test.trycloudflare.com/webhooks/levee';

  it('registers an endpoint for every event Acme handles when none is saved', async () => {
    const api = new FakeEndpointApi();
    const result = await ensureWebhookEndpoint(api, TEST_PLATFORM_ID, first, null);
    expect(result.registered).toBe(true);
    expect(result.endpoint).toEqual({ id: 'wpe_test_1', url: first, secret: 'whsec_test_secret_1' });
    expect(api.posts).toEqual([{ url: first, events: [...WEBHOOK_EVENT_TYPES] }]);
    expect(result.staleTunnelEndpoints).toBe(0);
  });

  it('reuses the saved endpoint when it is active with the same URL and events', async () => {
    const api = new FakeEndpointApi();
    const { endpoint } = await ensureWebhookEndpoint(api, TEST_PLATFORM_ID, first, null);
    const again = await ensureWebhookEndpoint(api, TEST_PLATFORM_ID, first, endpoint);
    expect(again).toEqual({ endpoint, registered: false, staleTunnelEndpoints: 0 });
    expect(api.posts).toHaveLength(1);
  });

  it('registers again when the tunnel URL changes, and counts the earlier tunnel endpoint', async () => {
    const api = new FakeEndpointApi();
    const { endpoint } = await ensureWebhookEndpoint(api, TEST_PLATFORM_ID, first, null);
    api.endpoints.push({ id: 'wpe_test_prod', url: 'https://acme.example.com/webhooks/levee', events: [] });
    const moved = await ensureWebhookEndpoint(api, TEST_PLATFORM_ID, second, endpoint);
    expect(moved.registered).toBe(true);
    expect(moved.endpoint.url).toBe(second);
    expect(moved.staleTunnelEndpoints).toBe(1);
  });

  it('registers again when the saved endpoint is gone, disabled or subscribed to other events', async () => {
    const api = new FakeEndpointApi();
    const missing = await ensureWebhookEndpoint(api, TEST_PLATFORM_ID, first, {
      id: 'wpe_test_unknown',
      url: first,
      secret: 'whsec_test_old',
    });
    expect(missing.registered).toBe(true);

    const disabled = api.endpoints[0];
    if (disabled === undefined) throw new Error('expected an endpoint');
    disabled.disabled_at = '2030-01-15T12:00:00.000Z';
    expect((await ensureWebhookEndpoint(api, TEST_PLATFORM_ID, first, missing.endpoint)).registered).toBe(true);

    const current = api.endpoints[0];
    if (current === undefined) throw new Error('expected an endpoint');
    current.events = ['mandate.activated'];
    const saved = { id: current.id, url: first, secret: 'whsec_test_secret_2' };
    expect((await ensureWebhookEndpoint(api, TEST_PLATFORM_ID, first, saved)).registered).toBe(true);
    expect(api.posts).toHaveLength(3);
  });

  it('fails without echoing the response when Levee returns no signing secret', async () => {
    const api = new FakeEndpointApi();
    api.answer = () => ({ id: 'wpe_test_1', url: first, secret: 'not-a-whsec-value' });
    await expect(ensureWebhookEndpoint(api, TEST_PLATFORM_ID, first, null)).rejects.toThrow(
      /^Levee did not return the new webhook endpoint and its signing secret$/,
    );
  });
});

describe('webhooks through the tunnel', () => {
  let harness: Harness;
  const tunnelSecret = 'whsec_test_tunnel_secret_value';
  const url = 'https://gentle-river-example-test.trycloudflare.com/webhooks/levee';

  beforeAll(async () => {
    harness = await Harness.create();
  });
  afterAll(() => harness.close());

  it('stores the endpoint encrypted and shows it in the status summary without the secret', async () => {
    expect(await savedWebhookEndpoint(harness.db, harness.ctx.encryptionKey)).toBeNull();
    await saveWebhookEndpoint(
      harness.db,
      harness.ctx.encryptionKey,
      { id: 'wpe_test_1', url, secret: tunnelSecret },
      harness.clock,
    );
    expect(await savedWebhookEndpoint(harness.db, harness.ctx.encryptionKey)).toEqual({
      id: 'wpe_test_1',
      url,
      secret: tunnelSecret,
    });
    const summary = await platformSummary(harness.db);
    expect(summary).toMatchObject({
      webhookEndpointId: 'wpe_test_1',
      webhookEndpointUrl: url,
      webhookEndpointSecretLast4: 'alue',
    });
    expect(JSON.stringify(summary)).not.toContain(tunnelSecret);
  });

  it('accepts a delivery signed with the tunnel endpoint secret, with the tunnel host and no CSRF token', async () => {
    const body = JSON.stringify({
      event_id: 'evt_test_tunnel_1',
      type: 'kill_switch.engaged',
      created_at: harness.clock.toISOString(),
      tenant_id: TEST_TENANT_ID,
      data: {},
    });
    const response = await harness.request(url, {
      method: 'POST',
      headers: {
        host: 'gentle-river-example-test.trycloudflare.com',
        origin: 'https://elsewhere.example',
        'x-forwarded-for': '203.0.113.7',
        'x-forwarded-proto': 'https',
        'content-type': 'application/json',
        'levee-signature': webhookSignatureHeader(tunnelSecret, Math.floor(harness.clock.getTime() / 1000), body),
      },
      body,
    });
    expect(response.status).toBeLessThan(300);
  });

  it('still refuses a delivery signed with any other secret', async () => {
    const body = JSON.stringify({
      event_id: 'evt_test_tunnel_2',
      type: 'kill_switch.engaged',
      created_at: harness.clock.toISOString(),
      tenant_id: TEST_TENANT_ID,
      data: {},
    });
    const response = await harness.request('/webhooks/levee', {
      method: 'POST',
      headers: {
        'levee-signature': webhookSignatureHeader(
          'whsec_test_someone_else',
          Math.floor(harness.clock.getTime() / 1000),
          body,
        ),
      },
      body,
    });
    expect(response.status).toBe(401);
  });
});

describe('passkey domain for the run', () => {
  const origin = 'https://gentle-river-example-test.trycloudflare.com';
  const android = `android:apk-key-hash:${'A'.repeat(43)}`;

  function fakeLevee(webauthn: { rpId?: string; origins?: string[] }) {
    const patches: { path: string; body: unknown }[] = [];
    return {
      patches,
      get: <T>(path: string): Promise<T> => {
        expect(path).toBe(`/v1/platforms/${TEST_PLATFORM_ID}/tenants`);
        return Promise.resolve([{ id: TEST_TENANT_ID, webauthn }] as T);
      },
      patch: <T>(path: string, body: unknown): Promise<T> => {
        patches.push({ path, body });
        return Promise.resolve({} as T);
      },
    };
  }

  it('makes the tunnel host the RP ID and its origin the only web origin, keeping app origins', async () => {
    const levee = fakeLevee({ rpId: 'localhost', origins: ['http://localhost:5173', android] });
    expect(await pointPasskeysAt(levee, TEST_PLATFORM_ID, TEST_TENANT_ID, origin)).toBe(true);
    expect(levee.patches).toEqual([
      {
        path: `/v1/platforms/${TEST_PLATFORM_ID}/tenants/${TEST_TENANT_ID}/webauthn`,
        body: { rp_id: 'gentle-river-example-test.trycloudflare.com', origins: [origin, android] },
      },
    ]);
  });

  it('leaves the tenant alone when it already points at this origin', async () => {
    const levee = fakeLevee({ rpId: 'gentle-river-example-test.trycloudflare.com', origins: [origin] });
    expect(await pointPasskeysAt(levee, TEST_PLATFORM_ID, TEST_TENANT_ID, origin)).toBe(false);
    expect(levee.patches).toEqual([]);
  });

  it('fails clearly when the key no longer owns the tenant', async () => {
    const levee = fakeLevee({});
    await expect(pointPasskeysAt(levee, TEST_PLATFORM_ID, 'ten_test_other', origin)).rejects.toThrow(/npm run setup/);
  });
});

describe('npm run dev preflight', () => {
  it('names the environment it cannot start without', () => {
    expect(missingEnv({})).toEqual(['DATABASE_URL', 'ACME_ENCRYPTION_KEY']);
    expect(missingEnv({ DATABASE_URL: 'postgres://x', ACME_ENCRYPTION_KEY: '  ' })).toEqual(['ACME_ENCRYPTION_KEY']);
    expect(missingEnv({ DATABASE_URL: 'postgres://x', ACME_ENCRYPTION_KEY: 'k' })).toEqual([]);
  });

  it('lists every missing credential variable when there is no terminal to ask at', async () => {
    const names = [
      'ACME_SETUP_LEVEE_TENANT_ID',
      'ACME_SETUP_LEVEE_PLATFORM_KEY',
      'ACME_SETUP_AIRWALLEX_CLIENT_ID',
      'ACME_SETUP_AIRWALLEX_API_KEY',
      'ACME_SETUP_LEVEE_WEBHOOK_SECRET',
    ];
    const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    try {
      for (const name of names) Reflect.deleteProperty(process.env, name);
      process.env.ACME_SETUP_LEVEE_TENANT_ID = 'ten_test_123';
      await expect(readSetupInput({ optional: ['webhookSecret'], command: 'npm run dev' })).rejects.toThrow(
        'Set ACME_SETUP_LEVEE_PLATFORM_KEY, ACME_SETUP_AIRWALLEX_CLIENT_ID, ACME_SETUP_AIRWALLEX_API_KEY (see .env.example)',
      );
      process.env.ACME_SETUP_LEVEE_PLATFORM_KEY = 'sk_test_platform_key_value';
      process.env.ACME_SETUP_AIRWALLEX_CLIENT_ID = 'client_id_test';
      process.env.ACME_SETUP_AIRWALLEX_API_KEY = 'api_key_test_value_000';
      expect(await readSetupInput({ optional: ['webhookSecret'], command: 'npm run dev' })).toMatchObject({
        leveeTenantId: 'ten_test_123',
        webhookSecret: '',
      });
    } finally {
      for (const name of names) {
        const value = saved[name];
        if (value === undefined) Reflect.deleteProperty(process.env, name);
        else process.env[name] = value;
      }
    }
  });

  it('draws the summary box around every line', () => {
    expect(summaryBox(['Open Acme at https://a.example', 'ok']).split('\n')).toEqual([
      '┌────────────────────────────────┐',
      '│ Open Acme at https://a.example │',
      '│ ok                             │',
      '└────────────────────────────────┘',
    ]);
  });
});

describe('setup without an operator webhook secret', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await Harness.create({ configured: false });
  });
  afterAll(() => harness.close());

  const deps = () => ({
    db: harness.db,
    encryptionKey: harness.ctx.encryptionKey,
    publicUrl: PUBLIC_URL,
    leveeApiUrl: 'https://levee.test',
    leveeConsoleOrigin: 'https://levee.test',
    airwallex: harness.ctx.airwallex,
    fetch: harness.levee.fetch,
    now: () => harness.clock,
  });
  const input = {
    leveePlatformKey: 'sk_test_platform_key_value',
    leveeTenantId: TEST_TENANT_ID,
    airwallexClientId: 'client_id_test',
    airwallexApiKey: 'api_key_test_value_000',
  };

  it('still rejects a malformed secret but accepts a blank one', async () => {
    await expect(runSetup(deps(), { ...input, webhookSecret: 'nope' })).rejects.toThrow(/whsec_/);
    await runSetup(deps(), { ...input, webhookSecret: '' });
    expect((await harness.ctx.platform.credentials()).webhookSecrets).toEqual([]);
    expect((await platformSummary(harness.db))?.webhookSecretLast4).toBe('');
  });
});

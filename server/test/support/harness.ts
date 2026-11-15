import { randomBytes } from 'node:crypto';
import webpush from 'web-push';
import { provisioningRun } from '../../src/accounts/provisioning';
import { AirwallexClient } from '../../src/airwallex/client';
import { createApp } from '../../src/app';
import type { AppContext, PushSender, PushTarget, VapidKeys } from '../../src/context';
import type { Database } from '../../src/db/client';
import type { DecisionModel } from '../../src/decision-model/client';
import { webhookSignatureHeader } from '../../src/levee/webhook-signature';
import { Platform, savePlatformCredentials } from '../../src/platform/platform';
import { createTestDatabase } from './database';
import { FakeAirwallex } from './fake-airwallex';
import { FakeLevee, TEST_PLATFORM_ID, TEST_TENANT_ID } from './fake-levee';

export const PUBLIC_URL = 'http://localhost:5173';
export const WEBHOOK_SECRET = 'whsec_test_secret_value';
export const VAPID_KEYS = webpush.generateVAPIDKeys();

/** Records Web Push sends instead of calling a push service. `refuse` scripts a push service error. */
export class FakePush implements PushSender {
  readonly sent: { target: PushTarget; payload: Record<string, unknown>; vapid: VapidKeys }[] = [];
  refuse: ((target: PushTarget) => number | null) | null = null;

  send(target: PushTarget, payload: string, vapid: VapidKeys): Promise<void> {
    const status = this.refuse?.(target) ?? null;
    if (status !== null) {
      return Promise.reject(Object.assign(new Error(`push service answered ${status}`), { statusCode: status }));
    }
    this.sent.push({ target, payload: JSON.parse(payload) as Record<string, unknown>, vapid });
    return Promise.resolve();
  }
}

/** A browser push subscription as `PushSubscription.toJSON()` returns it. */
export function testSubscription(n = 1) {
  return {
    endpoint: `https://push.example.test/send/device-${n}`,
    keys: { p256dh: VAPID_KEYS.publicKey, auth: 'dGVzdC1hdXRoLXNlY3JldA' }, // gitleaks:allow (test fixture)
  };
}

/** A whole Acme Pay app on PGlite with Levee and Airwallex faked, plus helpers to drive it. */
export class Harness {
  readonly levee: FakeLevee;
  readonly airwallex = new FakeAirwallex();
  readonly push = new FakePush();
  readonly ctx: AppContext;
  readonly app: ReturnType<typeof createApp>;
  clock = new Date('2030-01-15T12:00:00.000Z');

  private constructor(
    readonly db: Database,
    private readonly closeDb: () => Promise<void>,
    decisionModel: DecisionModel | null,
  ) {
    this.levee = new FakeLevee(() => this.clock);
    const encryptionKey = randomBytes(32);
    this.ctx = {
      db,
      encryptionKey,
      publicUrl: PUBLIC_URL,
      secureCookies: false,
      trustProxy: false,
      platform: new Platform(
        db,
        { encryptionKey, leveeApiUrl: 'https://levee.test', leveeConsoleOrigin: 'https://levee.test' },
        this.levee.fetch,
      ),
      airwallex: new AirwallexClient({
        baseUrl: 'https://airwallex.test',
        fetch: this.airwallex.fetch,
        sleep: async () => {},
      }),
      decisionModel,
      now: () => this.clock,
      sleep: async () => {},
      push: this.push,
    };
    this.app = createApp(this.ctx);
  }

  static async create(
    options: {
      configured?: boolean;
      decisionModel?: DecisionModel;
      database?: { db: Database; close: () => Promise<void> };
    } = {},
  ): Promise<Harness> {
    const { db, close } = options.database ?? (await createTestDatabase());
    const harness = new Harness(db, close, options.decisionModel ?? null);
    if (options.configured !== false) {
      await savePlatformCredentials(
        db,
        harness.ctx.encryptionKey,
        {
          leveePlatformId: TEST_PLATFORM_ID,
          leveeTenantId: TEST_TENANT_ID,
          leveePlatformKey: 'sk_test_platform_key_value',
          airwallex: { clientId: 'client_id_test', apiKey: 'api_key_test_value_000' },
          webhookSecret: WEBHOOK_SECRET,
          vapid: VAPID_KEYS,
        },
        harness.clock,
      );
    }
    return harness;
  }

  close(): Promise<void> {
    return this.closeDb();
  }

  advance(ms: number): void {
    this.clock = new Date(this.clock.getTime() + ms);
  }

  request(path: string, init: RequestInit = {}): Promise<Response> {
    return Promise.resolve(this.app.request(path, init));
  }

  /** A browser-like JSON request from the app's own origin. */
  browser(
    path: string,
    options: { method?: string; body?: unknown; cookie?: string; csrf?: string } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { origin: PUBLIC_URL };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.cookie !== undefined) headers.cookie = options.cookie;
    if (options.csrf !== undefined) headers['x-csrf-token'] = options.csrf;
    return this.request(path, {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  }

  /** Signs up and returns the session; the card account starts opening in the background. */
  async signup(email: string, name = 'Test Person'): Promise<{ cookie: string; csrf: string; userId: string }> {
    const response = await this.browser('/api/auth/signup', {
      body: { email, password: 'correct horse battery', name },
    });
    const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const { csrfToken, user } = (await response.json()) as { csrfToken: string; user: { id: string } };
    return { cookie, csrf: csrfToken, userId: user.id };
  }

  /** Waits for the person's background account provisioning (a no-op when none is running). */
  provisioned(userId: string): Promise<void> {
    return provisioningRun(userId);
  }

  /** Signs up, waits for the card account and enrols a passkey. */
  async signedInUser(email = 'person@example.com'): Promise<{ cookie: string; csrf: string }> {
    const { cookie, csrf, userId } = await this.signup(email);
    const session = { cookie, csrf };
    await this.provisioned(userId);
    const options = (await (await this.browser('/api/passkeys/options', { body: {}, ...session })).json()) as {
      requestId: string;
    };
    await this.browser('/api/passkeys', {
      body: { requestId: options.requestId, response: { id: 'cred_test_1', type: 'public-key' } },
      ...session,
    });
    return session;
  }

  /** Creates an agent and returns its MCP bearer token. */
  async agentToken(
    session: { cookie: string; csrf: string },
    client = 'claude_desktop',
  ): Promise<{ token: string; agentId: string }> {
    const response = await this.browser('/api/agents', {
      body: { name: 'Shopping agent', client },
      ...session,
    });
    const body = (await response.json()) as { token: string; agent: { id: string } };
    return { token: body.token, agentId: body.agent.id };
  }

  async mcp(
    token: string,
    method: string,
    params?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await this.request('/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  /** Calls a tool and returns its structured result, or its error text. */
  async tool(token: string, name: string, args: Record<string, unknown> = {}) {
    const { body } = await this.mcp(token, 'tools/call', { name, arguments: args });
    const result = body.result as
      { structuredContent?: Record<string, unknown>; isError?: boolean; content: { text: string }[] } | undefined;
    if (result === undefined) throw new Error(`protocol error: ${JSON.stringify(body.error)}`);
    return {
      data: result.structuredContent ?? {},
      isError: result.isError === true,
      text: result.content[0]?.text ?? '',
    };
  }

  /** Delivers a signed Levee webhook. */
  webhook(
    type: string,
    data: Record<string, unknown>,
    eventId = `evt_test_${Math.random().toString(36).slice(2)}`,
  ): Promise<Response> {
    const body = JSON.stringify({
      event_id: eventId,
      type,
      created_at: this.clock.toISOString(),
      tenant_id: TEST_TENANT_ID,
      data,
    });
    const timestamp = Math.floor(this.clock.getTime() / 1000);
    return this.request('/webhooks/levee', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'levee-signature': webhookSignatureHeader(WEBHOOK_SECRET, timestamp, body),
      },
      body,
    });
  }

  /** Requests a mandate over MCP, approves it with a (faked) passkey and delivers Levee's activation. */
  async activeMandate(token: string, capMinor = 10_000): Promise<{ mandateId: string; approvalUrl: string }> {
    const requested = await this.tool(token, 'acme_request_mandate', {
      amount_cap_minor: capMinor,
      categories: ['electronics'],
      window: { days: 7 },
      purpose: 'a USB-C hub, this week',
    });
    const approvalUrl = String(requested.data.approval_url);
    const approvalToken = approvalUrl.split('/approve/')[1] ?? '';
    const options = (await (
      await this.browser(`/api/approvals/${approvalToken}/options`, { body: { action: 'approve' } })
    ).json()) as {
      requestId: string;
    };
    await this.browser(`/api/approvals/${approvalToken}/approve`, {
      body: { requestId: options.requestId, response: ASSERTION },
    });
    const mandateId = [...this.levee.mandates.keys()].at(-1) ?? '';
    await this.webhook('mandate.activated', { mandate_id: mandateId, version: 1 });
    return { mandateId, approvalUrl };
  }
}

/** A well-formed WebAuthn assertion; the fake Levee accepts it like a real one would be verified. */
export const ASSERTION = {
  id: 'cred_test_1',
  type: 'public-key',
  response: { authenticatorData: 'YXV0aA', clientDataJSON: 'Y2xpZW50', signature: 'c2ln' },
};

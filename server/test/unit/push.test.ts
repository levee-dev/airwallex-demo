import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { platformConfig } from '../../src/db/schema';
import { deviceLabel, expiresIn, parseSubscription } from '../../src/push/service';
import { Harness, PUBLIC_URL, testSubscription } from '../support/harness';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 Version/18.1 Mobile/15E148';

describe('phone notifications', () => {
  let harness: Harness;
  let session: { cookie: string; csrf: string };
  let token: string;
  beforeAll(async () => {
    harness = await Harness.create();
    session = await harness.signedInUser();
    ({ token } = await harness.agentToken(session));
  });
  afterAll(() => harness.close());

  async function subscribe(n: number, userAgent = IPHONE) {
    return harness.request('/api/push/subscriptions', {
      method: 'POST',
      headers: {
        origin: PUBLIC_URL,
        'content-type': 'application/json',
        cookie: session.cookie,
        'x-csrf-token': session.csrf,
        'user-agent': userAgent,
      },
      body: JSON.stringify({ subscription: testSubscription(n) }),
    });
  }

  it('tells the phone step the public URL and VAPID key, with no devices yet', async () => {
    const response = await harness.browser('/api/push', session);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ configured: true, publicUrl: PUBLIC_URL, devices: [] });
    expect(typeof body.publicKey).toBe('string');
    const me = await harness.browser('/api/auth/me', session);
    expect(await me.json()).toMatchObject({ user: { phoneNotifications: false } });
  });

  it('stores a subscription and names the device', async () => {
    const response = await subscribe(1);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ device: { label: 'iPhone' }, devices: [{ label: 'iPhone' }] });
    const me = await harness.browser('/api/auth/me', session);
    expect(await me.json()).toMatchObject({ user: { phoneNotifications: true } });
    // The same browser subscribing again is one device, not two.
    await subscribe(1);
    const list = (await (await harness.browser('/api/push', session)).json()) as { devices: unknown[] };
    expect(list.devices).toHaveLength(1);
  });

  it('refuses a malformed subscription', async () => {
    const response = await harness.browser('/api/push/subscriptions', {
      body: { subscription: { endpoint: 'http://push.example.test/x', keys: { p256dh: 'x', auth: 'y' } } },
      ...session,
    });
    expect(response.status).toBe(400);
  });

  it('sends a test notification signed with the stored VAPID keys', async () => {
    const before = harness.push.sent.length;
    const response = await harness.browser('/api/push/test', { body: {}, ...session });
    expect(response.status).toBe(200);
    const [sent] = harness.push.sent.slice(before);
    expect(sent?.target.endpoint).toBe(testSubscription(1).endpoint);
    expect(sent?.payload).toMatchObject({ url: `${PUBLIC_URL}/dashboard` });
    const [row] = await harness.db.select().from(platformConfig);
    expect(sent?.vapid.publicKey).toBe(row?.vapidPublicKey);
    expect(sent?.vapid.subject).toMatch(/^mailto:/);
  });

  it('pushes a pending mandate approval with its link, without waiting for the push', async () => {
    const before = harness.push.sent.length;
    const requested = await harness.tool(token, 'acme_request_mandate', {
      amount_cap_minor: 5_000,
      categories: ['electronics'],
      window: { days: 7 },
      purpose: 'a USB-C hub, this week',
    });
    const mandateId = [...harness.levee.mandates.keys()].at(-1) ?? '';
    const response = await harness.webhook('mandate.pending_approval', { mandate_id: mandateId, version: 1 });
    expect(response.status).toBe(200);
    await vi.waitFor(() => {
      expect(harness.push.sent.length).toBeGreaterThan(before);
    });
    const payload = harness.push.sent.at(-1)?.payload;
    expect(payload).toMatchObject({ title: expect.stringContaining('$50') as string });
    expect(String(payload?.body)).toMatch(/expires in \d+ min/);
    expect(payload?.url).toBe(requested.data.approval_url);
  });

  it('pushes a purchase that needs the person, naming merchant and amount', async () => {
    const { mandateId } = await harness.activeMandate(token);
    const challenge = harness.levee.openChallenge(mandateId, 2_500);
    const before = harness.push.sent.length;
    await harness.webhook('challenge.created', {
      mandate_id: mandateId,
      version: 1,
      challenge_id: challenge.id,
      amount_minor: 2_500,
      currency: 'USD',
      merchant_name: 'Best Gadgets',
      mcc: '5732',
    });
    await vi.waitFor(() => {
      expect(harness.push.sent.length).toBeGreaterThan(before);
    });
    const payload = harness.push.sent.at(-1)?.payload;
    expect(String(payload?.body)).toContain('Best Gadgets $25 needs your OK');
    expect(String(payload?.url)).toMatch(new RegExp(`^${PUBLIC_URL}/approve/apr_`));
  });

  it('never fails webhook processing when the push service fails, and drops gone subscriptions', async () => {
    await subscribe(2, 'Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile Safari/537.36');
    harness.push.refuse = (target) => (target.endpoint.endsWith('device-1') ? 410 : 500);
    const mandateId = [...harness.levee.mandates.keys()].at(-1) ?? '';
    const challenge = harness.levee.openChallenge(mandateId, 1_000);
    const response = await harness.webhook('challenge.created', {
      mandate_id: mandateId,
      version: 1,
      challenge_id: challenge.id,
      amount_minor: 1_000,
      currency: 'USD',
      merchant_name: 'Cable Shop',
    });
    expect(response.status).toBe(200);
    await vi.waitFor(async () => {
      const list = (await (await harness.browser('/api/push', session)).json()) as { devices: { label: string }[] };
      expect(list.devices.map((device) => device.label)).toEqual(['Android phone']);
    });
    harness.push.refuse = null;
  });
});

describe('push helpers', () => {
  it('labels devices from their user agent', () => {
    expect(deviceLabel(IPHONE)).toBe('iPhone');
    expect(deviceLabel('Mozilla/5.0 (Linux; Android 15) Mobile')).toBe('Android phone');
    expect(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('Mac');
    expect(deviceLabel(null)).toBe('this browser');
  });

  it('accepts only https endpoints with well-formed keys', () => {
    expect(parseSubscription(testSubscription(3)).endpoint).toContain('device-3');
    expect(() => parseSubscription({ endpoint: 'https://x.test', keys: {} })).toThrow(/invalid push/);
    expect(() => parseSubscription(null)).toThrow(/invalid push/);
  });

  it('words the expiry', () => {
    const now = new Date('2030-01-01T00:00:00Z');
    expect(expiresIn(new Date('2030-01-01T00:15:00Z'), now)).toBe('expires in 15 min');
    expect(expiresIn(new Date('2030-01-01T05:00:00Z'), now)).toBe('expires in 5 h');
  });
});

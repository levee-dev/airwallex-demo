import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accountStatus,
  accountView,
  requireCardAccount,
  retryable,
  startProvisioning,
} from '../../src/accounts/provisioning';
import type { User } from '../../src/auth/sessions';
import { platformConfig, users } from '../../src/db/schema';
import { AppError } from '../../src/lib/errors';
import { derivePasskeyRpId, runSetup } from '../../src/platform/setup';
import { Harness, PUBLIC_URL } from '../support/harness';

describe('end-user account provisioning', () => {
  let harness: Harness;
  beforeAll(async () => {
    harness = await Harness.create();
  });
  afterAll(() => harness.close());

  async function account(session: { cookie: string; csrf: string }) {
    const response = await harness.browser('/api/account', session);
    return ((await response.json()) as { account: { status: string; error: string | null } }).account;
  }

  it('opens the card account in the background after sign-up, then links it to the approver', async () => {
    const session = await harness.signup('sam@example.com', 'Sam Lee 2');
    await harness.provisioned(session.userId);
    expect(await account(session)).toMatchObject({ status: 'ready', error: null });
    expect(harness.airwallex.created).toHaveLength(1);
    expect(harness.airwallex.created[0]).toMatchObject({
      primary_contact: { email: 'sam@example.com' },
      account_details: { business_person_details: [{ first_name: 'Sam', last_name: 'Lee' }] },
    });
    const [approver] = harness.levee.callsTo('POST', /^\/v1\/approvers$/);
    expect(approver?.body).toEqual({ kind: 'end_user', external_ref: expect.any(String) as string });
    const [link] = harness.levee.callsTo('POST', /^\/v1\/approvers\/[^/]+\/issuer-account$/);
    expect(link?.body).toEqual({ issuer_account_ref: 'acct_test_1' });
  });

  it('gives two users two different accounts', async () => {
    const session = await harness.signup('alex@example.com');
    await harness.provisioned(session.userId);
    const refs = harness.levee
      .callsTo('POST', /\/issuer-account$/)
      .map((call) => (call.body as { issuer_account_ref: string }).issuer_account_ref);
    expect(new Set(refs).size).toBe(2);
  });

  it('lets the passkey step run while the account is still opening', async () => {
    harness.airwallex.activationFailures = 1_000;
    const session = await harness.signup('early@example.com');
    const options = await harness.browser('/api/passkeys/options', { body: {}, ...session });
    expect(options.status).toBe(200);
    await harness.provisioned(session.userId);
    harness.airwallex.activationFailures = 0;
    expect(harness.levee.callsTo('POST', /^\/v1\/approvers$/)).toHaveLength(3);
  });

  it('marks the account failed after its retries, and the retry resumes the same account', async () => {
    harness.airwallex.activationFailures = 1_000;
    const session = await harness.signup('pending@example.com');
    await harness.provisioned(session.userId);
    expect(await account(session)).toMatchObject({
      status: 'failed',
      error: 'Airwallex has not activated the account yet.',
    });
    const created = harness.airwallex.created.length;
    const accountId = `acct_test_${created}`;
    expect(harness.airwallex.accounts.get(accountId)).toBe('SUBMITTED');

    harness.airwallex.activationFailures = 0;
    const retried = await harness.browser('/api/account/provision', { body: {}, ...session });
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ user: { account: { status: 'opening' } } });
    await harness.provisioned(session.userId);
    expect(await account(session)).toMatchObject({ status: 'ready' });
    expect(harness.airwallex.created).toHaveLength(created);
    expect(harness.airwallex.accounts.get(accountId)).toBe('ACTIVE');
  });

  it('resumes an account left SUBMITTED on the next status read', async () => {
    harness.airwallex.activationFailures = 1_000;
    const session = await harness.signup('resume@example.com');
    await harness.provisioned(session.userId);
    // As if the server stopped mid-run: no failure recorded, the account still SUBMITTED.
    await harness.db.update(users).set({ accountError: null }).where(eq(users.id, session.userId));
    harness.airwallex.activationFailures = 0;
    expect(await account(session)).toMatchObject({ status: 'opening' });
    await harness.provisioned(session.userId);
    expect(await account(session)).toMatchObject({ status: 'ready' });
  });

  it('retries the issuer-account link while Levee still sees the account as inactive', async () => {
    harness.levee.issuerAccountRefusals = 2;
    const session = await harness.signup('lag@example.com');
    await harness.provisioned(session.userId);
    expect(await account(session)).toMatchObject({ status: 'ready' });
  });
});

describe('provisioning state machine', () => {
  const user = (values: Partial<User>): User => ({
    id: 'usr_1',
    email: 'a@example.com',
    passwordHash: 'x',
    displayName: 'A',
    externalRef: 'eu_1',
    approverId: null,
    connectedAccountId: null,
    connectedAccountStatus: null,
    accountLinkedAt: null,
    accountError: null,
    createdAt: new Date(0),
    ...values,
  });

  it('is ready only once the ACTIVE account is linked to the approver', () => {
    expect(accountStatus(user({}))).toBe('opening');
    expect(accountStatus(user({ approverId: 'apv_1', connectedAccountStatus: 'SUBMITTED' }))).toBe('opening');
    expect(accountStatus(user({ approverId: 'apv_1', connectedAccountStatus: 'ACTIVE' }))).toBe('opening');
    const ready = user({ approverId: 'apv_1', connectedAccountStatus: 'ACTIVE', accountLinkedAt: new Date(0) });
    expect(accountStatus(ready)).toBe('ready');
    expect(accountStatus({ ...ready, accountError: 'stale' })).toBe('ready');
    expect(accountStatus(user({ accountError: 'Airwallex said no.' }))).toBe('failed');
    expect(accountView(user({ accountError: 'Airwallex said no.' }))).toMatchObject({ error: 'Airwallex said no.' });
  });

  it('retries only what time can fix', () => {
    expect(retryable(new AppError(409, 'account_pending', 'x'))).toBe(true);
    expect(retryable(new AppError(502, 'airwallex_unreachable', 'x'))).toBe(true);
    expect(retryable(new AppError(422, 'issuer_account_inactive', 'x'))).toBe(true);
    expect(retryable(new AppError(503, 'platform_not_configured', 'x'))).toBe(false);
    expect(retryable(new AppError(422, 'issuer_account_in_use', 'x'))).toBe(false);
    expect(retryable(new Error('x'))).toBe(false);
  });

  it('refuses card issuing until the account is ready, saying why', () => {
    expect(() => {
      requireCardAccount(user({}));
    }).toThrow(/still opening/);
    expect(() => {
      requireCardAccount(user({ accountError: 'x' }));
    }).toThrow(/couldn't be opened/);
    expect(() => {
      requireCardAccount(user({ approverId: 'apv_1', connectedAccountStatus: 'ACTIVE', accountLinkedAt: new Date(0) }));
    }).not.toThrow();
  });

  it('backs off between passes', async () => {
    const harness = await Harness.create();
    try {
      const waits: number[] = [];
      const ctx = { ...harness.ctx, sleep: (ms: number) => Promise.resolve(void waits.push(ms)) };
      harness.airwallex.activationFailures = 1_000;
      const session = await harness.signup('backoff@example.com');
      await harness.provisioned(session.userId);
      await harness.db.update(users).set({ accountError: null }).where(eq(users.id, session.userId));
      await startProvisioning(ctx, session.userId, [0, 10, 20]);
      expect(waits).toEqual([10, 20]);
      const [row] = await harness.db.select().from(users).where(eq(users.id, session.userId));
      expect(row?.accountError).not.toBeNull();
    } finally {
      await harness.close();
    }
  });
});

describe('card issuing waits for the card account', () => {
  let harness: Harness;
  beforeAll(async () => {
    harness = await Harness.create();
  });
  afterAll(() => harness.close());

  it('refuses to approve a mandate while the account is opening', async () => {
    const session = await harness.signedInUser('wait@example.com');
    const { token } = await harness.agentToken(session);
    const [row] = await harness.db.select().from(users).where(eq(users.email, 'wait@example.com'));
    await harness.db
      .update(users)
      .set({ accountLinkedAt: null })
      .where(eq(users.id, row?.id ?? ''));
    const requested = await harness.tool(token, 'acme_request_mandate', {
      amount_cap_minor: 5_000,
      categories: ['electronics'],
      window: { days: 7 },
      purpose: 'a USB-C hub, this week',
    });
    const approvalToken = String(requested.data.approval_url).split('/approve/')[1] ?? '';
    const options = await harness.browser(`/api/approvals/${approvalToken}/options`, { body: { action: 'approve' } });
    expect(options.status).toBe(409);
    expect(await options.json()).toMatchObject({ error: 'card_account_not_ready' });
  });
});

describe('operator setup', () => {
  let harness: Harness;
  beforeAll(async () => {
    harness = await Harness.create({ configured: false });
  });
  afterAll(() => harness.close());

  const input = {
    leveePlatformKey: 'sk_test_platform_key_value',
    leveeTenantId: 'ten_test_123',
    airwallexClientId: 'client_id_test',
    airwallexApiKey: 'api_key_test_value_000',
    webhookSecret: 'whsec_test_secret_value',
  };
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

  it('refuses requests until the platform is set up', async () => {
    const { cookie, csrf, userId } = await harness.signup('x@example.com', 'X');
    const options = await harness.browser('/api/passkeys/options', { body: {}, cookie, csrf });
    expect(options.status).toBe(503);
    await harness.provisioned(userId);
    const account = await harness.browser('/api/account', { cookie, csrf });
    expect(await account.json()).toMatchObject({
      account: { status: 'failed', error: expect.stringContaining('not set up') as string },
    });
  });

  it('validates formats before calling anyone', async () => {
    await expect(runSetup(deps(), { ...input, leveePlatformKey: 'sk_live_nope' })).rejects.toThrow(/sk_test_/);
    expect(harness.levee.calls).toHaveLength(0);
  });

  it('requires a sandbox consumer tenant the key owns', async () => {
    await expect(runSetup(deps(), { ...input, leveeTenantId: 'ten_test_other' })).rejects.toThrow(/does not own/);
    harness.levee.tenant.program_type = 'business';
    await expect(runSetup(deps(), input)).rejects.toThrow(/consumer/);
    harness.levee.tenant.program_type = 'consumer';
  });

  it('sets the tenant passkey RP ID and origin, and stores every secret encrypted', async () => {
    const report = await runSetup(deps(), input);
    expect(report).toMatchObject({
      leveePlatformId: 'plt_test_123',
      rpId: 'localhost',
      previousRpId: null,
      updatedWebauthn: true,
      origins: [PUBLIC_URL],
      generatedVapid: true,
    });
    expect(harness.levee.tenant.webauthn).toEqual({ rpId: 'localhost', origins: [PUBLIC_URL] });
    const [row] = await harness.db.select().from(platformConfig);
    const stored = JSON.stringify(row);
    expect(stored).not.toContain(input.leveePlatformKey);
    expect(stored).not.toContain(input.airwallexApiKey);
    expect(stored).not.toContain(input.webhookSecret);
    const { vapid } = await harness.ctx.platform.credentials();
    expect(vapid?.publicKey).toBe(row?.vapidPublicKey);
    expect(stored).not.toContain(vapid?.privateKey);
    expect(row?.passkeyRpId).toBe('localhost');
    expect(row?.leveePlatformKeyLast4).toBe('alue');
    expect((await harness.ctx.platform.credentials()).leveePlatformKey).toBe(input.leveePlatformKey);
  });

  it('keeps the push keys and leaves matching passkey settings alone on a second run', async () => {
    const before = (await harness.ctx.platform.credentials()).vapid;
    const patches = harness.levee.callsTo('PATCH', /webauthn$/).length;
    const report = await runSetup(deps(), input);
    expect(report).toMatchObject({ updatedWebauthn: false, generatedVapid: false });
    expect((await harness.ctx.platform.credentials()).vapid).toEqual(before);
    expect(harness.levee.callsTo('PATCH', /webauthn$/)).toHaveLength(patches);
  });

  it('asks before replacing a different RP ID, and refuses without a yes', async () => {
    harness.levee.tenant.webauthn = { rpId: 'old.example.com', origins: ['https://old.example.com'] };
    await expect(runSetup(deps(), input)).rejects.toThrow(/old\.example\.com.*stop working/);
    expect(harness.levee.tenant.webauthn.rpId).toBe('old.example.com');
    const asked: unknown[] = [];
    const declined = { ...deps(), confirmRpIdChange: (change: unknown) => Promise.resolve(!asked.push(change)) };
    await expect(runSetup(declined, input)).rejects.toThrow(/--force-rp-id/);
    expect(asked).toEqual([{ from: 'old.example.com', to: 'localhost' }]);
    const report = await runSetup({ ...deps(), confirmRpIdChange: () => Promise.resolve(true) }, input);
    expect(report).toMatchObject({ rpId: 'localhost', previousRpId: 'old.example.com', updatedWebauthn: true });
    expect(harness.levee.tenant.webauthn).toEqual({ rpId: 'localhost', origins: [PUBLIC_URL] });
  });

  it('reports Airwallex keys that cannot sign in', async () => {
    harness.airwallex.rejectLogin = true;
    await expect(runSetup(deps(), input)).rejects.toThrow(/rejected/);
    harness.airwallex.rejectLogin = false;
  });
});

describe('passkey RP ID', () => {
  it('is the public URL host by default', () => {
    expect(derivePasskeyRpId('http://localhost:5173')).toBe('localhost');
    expect(derivePasskeyRpId('https://Pay.Example.com', null)).toBe('pay.example.com');
    expect(derivePasskeyRpId('https://calm-river-1234.trycloudflare.com', '')).toBe(
      'calm-river-1234.trycloudflare.com',
    );
  });

  it('accepts an override that is a registrable suffix of the host', () => {
    expect(derivePasskeyRpId('https://pay.example.com', 'example.com')).toBe('example.com');
    expect(derivePasskeyRpId('https://pay.example.com', 'PAY.example.com.')).toBe('pay.example.com');
    expect(derivePasskeyRpId('https://a.b.example.co.uk', 'b.example.co.uk')).toBe('b.example.co.uk');
  });

  it('refuses an override that does not cover the host, a public suffix or a non-hostname', () => {
    expect(() => derivePasskeyRpId('https://pay.example.com', 'other.com')).toThrow(/parent domain/);
    expect(() => derivePasskeyRpId('https://pay.example.com', 'ample.com')).toThrow(/parent domain/);
    expect(() => derivePasskeyRpId('https://pay.example.com', 'com')).toThrow(/public suffix/);
    expect(() => derivePasskeyRpId('https://x.trycloudflare.com', 'trycloudflare.com')).toThrow(/public suffix/);
    expect(() => derivePasskeyRpId('https://pay.example.com', 'https://example.com')).toThrow(/bare hostname/);
    expect(() => derivePasskeyRpId('https://pay.example.com', 'example.com:443')).toThrow(/bare hostname/);
  });

  it('refuses an IP address host, which Levee never accepts as an RP ID', () => {
    expect(() => derivePasskeyRpId('http://127.0.0.1:5173')).toThrow(/IP address/);
  });
});

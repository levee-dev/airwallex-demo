import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RATE_LIMITS } from '../../src/auth/rate-limit';
import { Harness, PUBLIC_URL } from '../support/harness';

let harness: Harness;
beforeAll(async () => {
  harness = await Harness.create();
});
afterAll(() => harness.close());

const PASSWORD = 'correct horse battery';

async function signup(email: string) {
  const response = await harness.browser('/api/auth/signup', { body: { email, password: PASSWORD, name: 'Pat Doe' } });
  const body = (await response.json()) as { csrfToken: string };
  return { response, cookie: (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '', csrf: body.csrfToken };
}

describe('sign-up and sessions', () => {
  it('creates an account with an httpOnly, SameSite session cookie and a CSRF token', async () => {
    const { response, csrf } = await signup('pat@example.com');
    expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^acme_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(csrf.length).toBeGreaterThan(20);
  });

  it('refuses a second account for the same email, in any letter case', async () => {
    const { response } = await signup('PAT@example.com');
    expect(response.status).toBe(409);
  });

  it('refuses a short password', async () => {
    const response = await harness.browser('/api/auth/signup', {
      body: { email: 'short@example.com', password: 'short', name: 'Short' },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'weak_password' });
  });

  it('signs in with the right password only, with the same answer for an unknown email', async () => {
    const wrong = await harness.browser('/api/auth/login', {
      body: { email: 'pat@example.com', password: 'not the password' },
    });
    const unknown = await harness.browser('/api/auth/login', {
      body: { email: 'nobody@example.com', password: PASSWORD },
    });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.json()).toEqual(await unknown.json());
    const right = await harness.browser('/api/auth/login', { body: { email: 'pat@example.com', password: PASSWORD } });
    expect(right.status).toBe(200);
  });

  it('reads the session back and ends it on sign-out', async () => {
    const { cookie, csrf } = await signup('session@example.com');
    const me = await harness.browser('/api/auth/me', { cookie });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ user: { email: 'session@example.com', hasPasskey: false } });
    expect((await harness.browser('/api/auth/logout', { body: {}, cookie, csrf })).status).toBe(200);
    expect((await harness.browser('/api/auth/me', { cookie })).status).toBe(401);
  });

  it('expires sessions after seven days', async () => {
    const { cookie } = await signup('expiry@example.com');
    harness.advance(7 * 24 * 60 * 60 * 1000 + 1);
    expect((await harness.browser('/api/auth/me', { cookie })).status).toBe(401);
  });
});

describe('CSRF and origin checks', () => {
  it('requires the session CSRF token on unsafe requests', async () => {
    const { cookie, csrf } = await signup('csrf@example.com');
    const missing = await harness.browser('/api/agents', { body: { name: 'A', client: 'cursor' }, cookie });
    expect(missing.status).toBe(403);
    expect(await missing.json()).toMatchObject({ error: 'csrf_rejected' });
    const wrong = await harness.browser('/api/agents', {
      body: { name: 'A', client: 'cursor' },
      cookie,
      csrf: `${csrf}x`,
    });
    expect(wrong.status).toBe(403);
  });

  it('rejects unsafe requests from another origin before anything else', async () => {
    const response = await harness.request('/api/auth/login', {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'pat@example.com', password: PASSWORD }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'origin_rejected' });
  });

  it('accepts only JSON bodies', async () => {
    const response = await harness.request('/api/auth/login', {
      method: 'POST',
      headers: { origin: PUBLIC_URL, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'email=pat%40example.com',
    });
    expect(response.status).toBe(415);
  });
});

describe('rate limits', () => {
  it('limits sign-in attempts per email', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt <= RATE_LIMITS.loginPerEmail.max; attempt += 1) {
      const response = await harness.browser('/api/auth/login', {
        body: { email: 'limited@example.com', password: 'wrong password!' },
      });
      statuses.push(response.status);
    }
    expect(statuses.slice(0, -1).every((status) => status === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    harness.advance(RATE_LIMITS.loginPerEmail.windowMs + 1);
    const later = await harness.browser('/api/auth/login', {
      body: { email: 'limited@example.com', password: 'wrong password!' },
    });
    expect(later.status).toBe(401);
  });
});

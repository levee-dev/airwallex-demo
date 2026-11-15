import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectDatabase, migrateDatabase } from '../../src/db/client';
import { ASSERTION, Harness } from '../support/harness';

/**
 * Runs the app against a real Postgres. Set TEST_DATABASE_URL to a server where the user may create
 * databases (`docker compose up -d db` gives you one); each run creates and drops its own database.
 */
const baseUrl = process.env.TEST_DATABASE_URL;

async function reachable(url: string | undefined): Promise<boolean> {
  if (url === undefined) return false;
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

const available = await reachable(baseUrl);
if (!available) {
  console.warn(
    'Skipping Postgres integration tests: set TEST_DATABASE_URL to a reachable Postgres (for example postgres://acme:acme@localhost:5432/postgres after `docker compose up -d db`).',
  );
}

describe.skipIf(!available)('against a real Postgres', () => {
  const name = `acme_test_${randomBytes(6).toString('hex')}`;
  let admin: pg.Client;
  let harness: Harness;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: baseUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(baseUrl ?? '');
    url.pathname = `/${name}`;
    await migrateDatabase(url.toString());
    harness = await Harness.create({ database: connectDatabase(url.toString()) });
  });

  afterAll(async () => {
    await harness.close();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
  });

  it('runs the whole flow: sign-up, account, passkey, agent, mandate, purchase', async () => {
    const { token } = await harness.agentToken(await harness.signedInUser());
    await harness.activeMandate(token);
    const bought = await harness.tool(token, 'acme_purchase', {
      merchant: 'Amazon',
      amount: '12.00',
      description: 'Cable',
    });
    expect(bought.data).toMatchObject({ status: 'approved' });
  });

  it('lets exactly one of two concurrent decisions win an approval', async () => {
    const session = await harness.signedInUser('race@example.com');
    const { token } = await harness.agentToken(session);
    const requested = await harness.tool(token, 'acme_request_mandate', {
      amount_cap: '20.00',
      categories: ['books'],
      window: { days: 3 },
      purpose: 'a book',
    });
    const approvalToken = String(requested.data.approval_url).split('/approve/')[1] ?? '';
    const options = (await (
      await harness.browser(`/api/approvals/${approvalToken}/options`, { body: { action: 'approve' } })
    ).json()) as {
      requestId: string;
    };
    const [approve, decline] = await Promise.all([
      harness.browser(`/api/approvals/${approvalToken}/approve`, {
        body: { requestId: options.requestId, response: ASSERTION },
      }),
      harness.browser(`/api/approvals/${approvalToken}/decline`, { body: {} }),
    ]);
    expect([approve.status, decline.status].sort()).toEqual([200, 410]);
  });

  it('keeps rate limits in the database', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await harness.browser('/api/auth/login', {
        body: { email: 'pg-limit@example.com', password: 'wrong password!' },
      });
      statuses.push(response.status);
    }
    expect(statuses.at(-1)).toBe(429);
  });
});

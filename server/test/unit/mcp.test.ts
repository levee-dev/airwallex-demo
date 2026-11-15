import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TOOLS } from '../../src/mcp/tools';
import { ASSERTION, Harness, PUBLIC_URL } from '../support/harness';

let harness: Harness;
let token: string;

beforeAll(async () => {
  harness = await Harness.create();
  ({ token } = await harness.agentToken(await harness.signedInUser()));
});
afterAll(() => harness.close());

describe('MCP transport', () => {
  it('rejects a missing or wrong bearer token', async () => {
    expect((await harness.mcp('', 'tools/list')).status).toBe(401);
    expect((await harness.mcp('acme_agent_not_a_real_token', 'tools/list')).status).toBe(401);
  });

  it('negotiates a protocol version and lists the tools', async () => {
    const init = await harness.mcp(token, 'initialize', { protocolVersion: '2025-06-18' });
    expect(init.body.result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'acme-pay' } });
    const list = await harness.mcp(token, 'tools/list');
    const names = (list.body.result as { tools: { name: string }[] }).tools.map((tool) => tool.name);
    expect(names).toEqual(TOOLS.map((tool) => tool.name));
    expect(names).not.toContain('approve');
  });

  it('connects a Codex agent over Streamable HTTP', async () => {
    const codex = await harness.agentToken(await harness.signedInUser('codex@example.com'), 'codex');
    const init = await harness.mcp(codex.token, 'initialize', { protocolVersion: '2025-06-18' });
    expect(init.status).toBe(200);
    expect(init.body.result).toMatchObject({ serverInfo: { name: 'acme-pay' } });
  });

  it('refuses requests from another browser origin', async () => {
    const response = await harness.request('/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        origin: 'https://evil.example',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(response.status).toBe(403);
  });

  it('treats unknown arguments as protocol errors', async () => {
    const { body } = await harness.mcp(token, 'tools/call', { name: 'acme_list_mandates', arguments: { extra: true } });
    expect(body.error).toMatchObject({ code: -32602 });
  });
});

describe('acme_request_mandate', () => {
  it('asks the person instead of guessing a missing amount', async () => {
    const result = await harness.tool(token, 'acme_request_mandate', {
      categories: ['electronics'],
      window: { days: 7 },
      purpose: 'a USB-C hub',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/how much may the agent spend/);
    expect(harness.levee.callsTo('POST', /^\/v1\/mandates$/)).toHaveLength(0);
  });

  it('maps typed fields to a Levee draft and returns a single-use approval link', async () => {
    const result = await harness.tool(token, 'acme_request_mandate', {
      amount_cap: '40.00',
      categories: ['electronics'],
      merchants: [{ name: 'Amazon' }],
      window: { days: 7 },
      purpose: 'a USB-C hub from Amazon, up to $40, this week',
    });
    expect(result.isError).toBe(false);
    expect(result.data).toMatchObject({ status: 'awaiting_approval' });
    expect(String(result.data.approval_url)).toMatch(new RegExp(`^${PUBLIC_URL}/approve/apr_`));
    expect(result.text).toContain(String(result.data.approval_url));
    const [call] = harness.levee.callsTo('POST', /^\/v1\/mandates$/);
    expect(call?.headers['x-levee-end-user']).toMatch(/^eu_/);
    expect(call?.body).toMatchObject({
      constraints: {
        budget: { currency: 'USD', max: 4000 },
        mcc: { allow: ['5942'] },
        merchants: { allow: [{ name: 'Amazon', descriptor_patterns: ['AMAZON.COM', 'AMZN MKTP US'] }] },
      },
      user_request: 'a USB-C hub from Amazon, up to $40, this week',
    });

    const status = await harness.tool(token, 'acme_request_status', { request_id: result.data.request_id });
    expect(status.data).toMatchObject({ status: 'awaiting_approval', approval_url: result.data.approval_url });
  });

  it('refuses a second mandate while one is waiting', async () => {
    const result = await harness.tool(token, 'acme_request_mandate', {
      amount_cap: '10.00',
      categories: ['books'],
      window: { days: 1 },
      purpose: 'a book',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/already has a mandate/);
  });
});

describe('approval and purchase', () => {
  let approvalToken: string;

  beforeAll(async () => {
    const listed = await harness.tool(token, 'acme_list_mandates');
    const approvals = listed.data.approvals as { approval_url: string }[];
    approvalToken = approvals[0]?.approval_url.split('/approve/')[1] ?? '';
  });

  it('shows the approval page without using up the link', async () => {
    const page = await harness.browser(`/api/approvals/${approvalToken}`);
    expect(page.status).toBe(200);
    expect(await page.json()).toMatchObject({ kind: 'mandate', allowedActions: ['approve', 'decline'] });
    expect((await harness.browser(`/api/approvals/${approvalToken}`)).status).toBe(200);
  });

  it('approves with a passkey ceremony bound to the link, once', async () => {
    const options = (await (
      await harness.browser(`/api/approvals/${approvalToken}/options`, { body: { action: 'approve' } })
    ).json()) as {
      requestId: string;
    };
    const approved = await harness.browser(`/api/approvals/${approvalToken}/approve`, {
      body: { requestId: options.requestId, response: ASSERTION },
    });
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({ status: 'approved' });
    const again = await harness.browser(`/api/approvals/${approvalToken}/decline`, { body: {} });
    expect(again.status).toBe(410);
  });

  it('has no spending authority until Levee confirms activation', async () => {
    const early = await harness.tool(token, 'acme_purchase', {
      merchant: 'Amazon',
      amount: '25.00',
      description: 'USB-C hub',
    });
    expect(early.isError).toBe(true);
    expect(early.text).toMatch(/no active mandate/);

    const mandateId = [...harness.levee.mandates.keys()][0] ?? '';
    expect((await harness.webhook('mandate.activated', { mandate_id: mandateId, version: 1 })).status).toBe(200);
  });

  it('buys within the mandate', async () => {
    const result = await harness.tool(token, 'acme_purchase', {
      merchant: 'Amazon',
      amount: '25.00',
      description: 'USB-C hub',
    });
    expect(result.data).toMatchObject({ status: 'approved' });
    const [declaration] = harness.levee.callsTo('POST', /^\/v1\/declarations$/);
    expect(declaration?.body).toMatchObject({
      payee: { name: 'Amazon', domain: 'amazon.com' },
      amount: { currency: 'USD', value: 2500 },
    });
    expect((declaration?.body as { agent_signature: string }).agent_signature.split('.')).toHaveLength(3);
    const [swipe] = harness.levee.callsTo('POST', /\/purchase$/);
    expect(swipe?.body).toMatchObject({ merchant: { name: 'AMAZON.COM', mcc: '5942', country: 'USA' }, amount: 25 });

    const status = await harness.tool(token, 'acme_purchase_status', { purchase_id: result.data.purchase_id });
    expect(status.data).toMatchObject({ status: 'authorized', charged: true, remaining_minor: 1500 });
  });

  it('returns an approval link for a step-up and the same link on retry, charging nothing', async () => {
    const mandateId = [...harness.levee.mandates.keys()][0] ?? '';
    const challenge = harness.levee.openChallenge(mandateId, 3000);
    harness.levee.nextPurchase = {
      response_status: 'DECLINED',
      status_reason: 'CHALLENGE_AMOUNT_OVER_MANDATE',
      card_transaction_event_id: 'evt_test_stepup',
      challenge_id: challenge.id,
      decision: { outcome: 'CHALLENGE', reasonCode: 'CHALLENGE_AMOUNT_OVER_MANDATE' },
    };
    const first = await harness.tool(token, 'acme_purchase', {
      merchant: 'Amazon',
      amount: '30.00',
      description: 'Monitor cable',
    });
    expect(first.data).toMatchObject({ status: 'approval_required' });
    const swipes = harness.levee.callsTo('POST', /\/purchase$/).length;

    const retry = await harness.tool(token, 'acme_purchase', {
      merchant: 'Amazon',
      amount: '30.00',
      description: 'Monitor cable',
    });
    expect(retry.data).toMatchObject({
      status: 'approval_required',
      approval_url: first.data.approval_url,
      purchase_id: first.data.purchase_id,
    });
    expect(harness.levee.callsTo('POST', /\/purchase$/)).toHaveLength(swipes);

    const stepUpToken = String(first.data.approval_url).split('/approve/')[1] ?? '';
    const page = (await (await harness.browser(`/api/approvals/${stepUpToken}`)).json()) as {
      allowedActions: string[];
    };
    expect(page.allowedActions).toEqual(['allow-once', 'allow-from-now-on', 'deny']);
    expect((await harness.browser(`/api/approvals/${stepUpToken}/deny`, { body: {} })).status).toBe(200);
  });

  it('reports a declaration-stage decline in plain words', async () => {
    harness.levee.nextDeclaration = {
      declaration: null,
      predicted: { outcome: 'decline', reason_codes: ['MERCHANT_NOT_ALLOWED'] },
    };
    const result = await harness.tool(token, 'acme_purchase', {
      merchant: 'Best Buy',
      amount: '5.00',
      description: 'Cable',
    });
    expect(result.data).toMatchObject({ status: 'declined', reason: 'This shop is not one you approved.' });
  });

  it('asks for a category for a merchant it does not know', async () => {
    const result = await harness.tool(token, 'acme_purchase', {
      merchant: 'Gadget Garage',
      merchant_url: 'https://gadget-garage.example',
      amount: '5.00',
      description: 'Cable',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/kind of purchase/);
  });
});

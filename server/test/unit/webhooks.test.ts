import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mandateVersions, mandates, purchases, webhookEvents } from '../../src/db/schema';
import { verifyWebhookSignature, webhookSignatureHeader } from '../../src/levee/webhook-signature';
import { Harness, WEBHOOK_SECRET } from '../support/harness';
import { defined } from '../support/defined';

describe('webhook signatures', () => {
  const body = '{"event_id":"evt_test_1"}';
  const nowMs = Date.parse('2030-01-15T12:00:00.000Z');
  const seconds = nowMs / 1000;

  it('accept a fresh signature over the exact bytes', () => {
    const header = webhookSignatureHeader(WEBHOOK_SECRET, seconds, body);
    expect(verifyWebhookSignature({ secret: WEBHOOK_SECRET, header, body, nowMs })).toBe(true);
    expect(verifyWebhookSignature({ secret: WEBHOOK_SECRET, header, body: `${body} `, nowMs })).toBe(false);
    expect(verifyWebhookSignature({ secret: 'whsec_other', header, body, nowMs })).toBe(false);
  });

  it('refuse old timestamps and malformed headers', () => {
    const stale = webhookSignatureHeader(WEBHOOK_SECRET, seconds - 301, body);
    expect(verifyWebhookSignature({ secret: WEBHOOK_SECRET, header: stale, body, nowMs })).toBe(false);
    const header = webhookSignatureHeader(WEBHOOK_SECRET, seconds, body);
    expect(
      verifyWebhookSignature({ secret: WEBHOOK_SECRET, header: `${header},v1=${'0'.repeat(64)}`, body, nowMs }),
    ).toBe(false);
    expect(verifyWebhookSignature({ secret: WEBHOOK_SECRET, header: 'v1=abc', body, nowMs })).toBe(false);
  });
});

describe('webhook receiver', () => {
  let harness: Harness;
  let token: string;
  let mandateId: string;

  beforeAll(async () => {
    harness = await Harness.create();
    ({ token } = await harness.agentToken(await harness.signedInUser()));
    ({ mandateId } = await harness.activeMandate(token));
  });
  afterAll(() => harness.close());

  it('rejects unsigned, badly signed and other-tenant deliveries', async () => {
    const unsigned = await harness.request('/webhooks/levee', { method: 'POST', body: '{}' });
    expect(unsigned.status).toBe(401);
    const body = JSON.stringify({
      event_id: 'evt_test_x',
      type: 'mandate.paused',
      created_at: '2030-01-15T12:00:00.000Z',
      tenant_id: 'ten_test_other',
      data: {},
    });
    const signature = webhookSignatureHeader(WEBHOOK_SECRET, Math.floor(harness.clock.getTime() / 1000), body);
    const other = await harness.request('/webhooks/levee', {
      method: 'POST',
      headers: { 'levee-signature': signature },
      body,
    });
    expect(other.status).toBe(403);
  });

  it('activates a version only on Levee’s signed activation, then shows the card', async () => {
    const [version] = await harness.db.select().from(mandateVersions).where(eq(mandateVersions.mandateId, mandateId));
    expect(version).toMatchObject({ status: 'active', activationConfirmed: true });
    const [mandate] = await harness.db.select().from(mandates).where(eq(mandates.id, mandateId));
    expect(mandate?.cardLast4).toBe('4242');
  });

  it('applies each event id once', async () => {
    const first = await harness.webhook('mandate.paused', { mandate_id: mandateId, version: 1 }, 'evt_test_dupe');
    const second = await harness.webhook('mandate.paused', { mandate_id: mandateId, version: 1 }, 'evt_test_dupe');
    expect(first.status).toBe(200);
    expect(await second.json()).toMatchObject({ duplicate: true });
  });

  it('reads state from Levee instead of trusting the event, and opens a resume approval on pause', async () => {
    defined(harness.levee.mandates.get(mandateId)).state = 'paused';
    await harness.webhook('mandate.paused', { mandate_id: mandateId, version: 1 });
    const listed = await harness.tool(token, 'acme_list_mandates');
    expect(listed.data.mandates).toMatchObject([{ status: 'paused' }]);
    expect(listed.data.approvals).toMatchObject([{ kind: 'resume' }]);

    // A late "activated" delivery cannot resume a paused mandate: Levee still says paused.
    await harness.webhook('mandate.activated', { mandate_id: mandateId, version: 1 });
    const again = await harness.tool(token, 'acme_list_mandates');
    expect(again.data.mandates).toMatchObject([{ status: 'paused' }]);
    defined(harness.levee.mandates.get(mandateId)).state = 'active';
    await harness.webhook('mandate.resumed', { mandate_id: mandateId, version: 1 });
  });

  it('keeps an issuer outcome that beats its purchase and applies it once the purchase exists', async () => {
    const early = await harness.webhook(
      'issuer.outcome',
      { mandate_id: mandateId, event_id: 'evt_test_late', outcome: 'FAILED', failure_reason: 'INSUFFICIENT_FUNDS' },
      'evt_test_outcome',
    );
    expect(early.status).toBe(202);
    harness.levee.nextPurchase = {
      response_status: 'UNCONFIRMED',
      status_reason: 'ISSUER_UNCONFIRMED',
      card_transaction_event_id: 'evt_test_late',
      challenge_id: null,
      decision: { outcome: 'APPROVE', reasonCode: 'OK_WITHIN_MANDATE' },
    };
    const bought = await harness.tool(token, 'acme_purchase', {
      merchant: 'Amazon',
      amount: '10.00',
      description: 'Charger',
    });
    expect(bought.data.status).toBe('unconfirmed');
    const status = await harness.tool(token, 'acme_purchase_status', { purchase_id: bought.data.purchase_id });
    expect(status.data).toMatchObject({ status: 'failed', charged: false });
    const [event] = await harness.db.select().from(webhookEvents).where(eq(webhookEvents.eventId, 'evt_test_outcome'));
    expect(event?.status).toBe('processed');
  });

  it('never lets a late AUTHORIZED undo a failure', async () => {
    await harness.webhook('issuer.outcome', {
      mandate_id: mandateId,
      event_id: 'evt_test_late',
      outcome: 'AUTHORIZED',
    });
    const [purchase] = await harness.db.select().from(purchases).where(eq(purchases.issuerEventId, 'evt_test_late'));
    expect(purchase?.outcome).toBe('failed');
  });

  it('ignores events about people Acme does not know', async () => {
    const response = await harness.webhook('mandate.activated', {
      mandate_id: 'mdt_test_unknown',
      version: 1,
      approver_id: 'apv_test_other',
    });
    expect(await response.json()).toMatchObject({ result: 'ignored' });
  });
});

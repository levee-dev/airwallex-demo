import { describe, expect, it } from 'vitest';
import { orderFromRequest } from '../../src/purchases/order';
import { RECOVERY_PAGE_LIMIT, recoverSwipe, settlePurchase, type SwipeAttempt } from '../../src/purchases/outcome';
import { plainReason } from '../../src/purchases/reasons';

const approve = { outcome: 'APPROVE', reasonCode: 'OK_WITHIN_MANDATE' };

describe('purchase outcome mapping', () => {
  it('records an authorization as approved', () => {
    expect(
      settlePurchase(
        { response_status: 'AUTHORIZED', status_reason: 'OK', challenge_id: null, decision: approve },
        { firstPurchase: false },
      ),
    ).toEqual({
      outcome: 'approved',
      reasonCodes: ['OK_WITHIN_MANDATE'],
      challengeId: null,
      issuerFailureReason: null,
    });
  });

  it('records an issuer failure after Levee approved as failed, with Acme wording', () => {
    const settled = settlePurchase(
      {
        response_status: 'FAILED',
        status_reason: 'x',
        issuer_failure_reason: 'INSUFFICIENT_FUNDS',
        challenge_id: null,
        decision: approve,
      },
      { firstPurchase: false },
    );
    expect(settled).toMatchObject({
      outcome: 'failed',
      reasonCodes: ['ISSUER_INSUFFICIENT_FUNDS'],
      issuerFailureReason: 'INSUFFICIENT_FUNDS',
    });
    expect(plainReason('ISSUER_INSUFFICIENT_FUNDS')).toMatch(/enough funds/);
  });

  it('never calls an unknown issuer result a decline', () => {
    const settled = settlePurchase(
      { response_status: 'UNCONFIRMED', status_reason: '', challenge_id: null, decision: approve },
      { firstPurchase: false },
    );
    expect(settled).toMatchObject({ outcome: 'unconfirmed', reasonCodes: ['ISSUER_UNCONFIRMED'] });
  });

  it('turns a challenge into needs_approval, using a recovered id when the answer lost it', () => {
    const challenge = { outcome: 'CHALLENGE', reasonCode: 'CHALLENGE_NEW_MERCHANT' };
    expect(
      settlePurchase(
        { response_status: 'DECLINED', status_reason: '', challenge_id: 'chl_test_1', decision: challenge },
        { firstPurchase: false },
      ),
    ).toMatchObject({ outcome: 'needs_approval', challengeId: 'chl_test_1' });
    expect(
      settlePurchase(
        { response_status: 'DECLINED', status_reason: '', challenge_id: null, decision: challenge },
        { firstPurchase: true, recoveredChallengeId: 'chl_test_2' },
      ),
    ).toMatchObject({ outcome: 'needs_approval', challengeId: 'chl_test_2' });
  });

  it('never declines a first purchase for the payee check that is the person’s approval', () => {
    const settled = settlePurchase(
      {
        response_status: 'DECLINED',
        status_reason: '',
        challenge_id: null,
        decision: { outcome: 'DECLINE', reasonCode: 'LEVEE_DECLARATION_PAYEE_MISMATCH' },
      },
      { firstPurchase: true },
    );
    expect(settled).toMatchObject({ outcome: 'declined', reasonCodes: ['FIRST_PURCHASE_NOT_SENT'] });
  });

  it('hides raw reason codes', () => {
    expect(plainReason('SOMETHING_NEW')).toBe('The payment was not approved.');
    expect(plainReason('LEVEE_BUDGET_EXCEEDED')).toBe('This would go over the budget you approved.');
  });
});

describe('timed-out swipe recovery', () => {
  const attempt: SwipeAttempt = {
    mandateId: 'mdt_test_1',
    cardId: 'crd_test_1',
    amountMinor: 2500,
    currency: 'USD',
    descriptor: 'AMAZON.COM',
    mcc: '5942',
    startedAtMs: Date.parse('2030-01-15T12:00:00.000Z'),
  };
  const decision = (overrides: Record<string, unknown> = {}) => ({
    eventId: 'evt_test_1',
    cardId: 'crd_test_1',
    mandateId: 'mdt_test_1',
    outcome: 'APPROVE',
    amountMinor: 2500,
    currency: 'USD',
    merchantName: 'AMAZON.COM',
    mcc: '5942',
    reasonCode: 'OK_WITHIN_MANDATE',
    reasons: [],
    createdAt: '2030-01-15T12:00:01.000Z',
    latencyMs: 9,
    issuerOutcome: 'AUTHORIZED',
    ...overrides,
  });
  const readAt = Date.parse('2030-01-15T12:00:30.000Z');

  it('settles on exactly one matching decision', () => {
    expect(recoverSwipe([decision()], attempt, readAt)).toMatchObject({
      result: { response_status: 'AUTHORIZED', card_transaction_event_id: 'evt_test_1' },
      latencyMs: 9,
    });
    expect(recoverSwipe([decision({ issuerOutcome: null })], attempt, readAt)?.result.response_status).toBe(
      'UNCONFIRMED',
    );
  });

  it('stays unknown on ambiguity, a mismatch, a malformed page or a full page', () => {
    expect(recoverSwipe([decision(), decision({ eventId: 'evt_test_2' })], attempt, readAt)).toBeNull();
    expect(recoverSwipe([decision({ amountMinor: 2400 })], attempt, readAt)).toBeNull();
    expect(recoverSwipe([decision({ createdAt: '2030-01-15T11:59:59.000Z' })], attempt, readAt)).toBeNull();
    expect(recoverSwipe([{ eventId: 1 }], attempt, readAt)).toBeNull();
    expect(recoverSwipe('nope', attempt, readAt)).toBeNull();
    const full = Array.from({ length: RECOVERY_PAGE_LIMIT }, (_, index) =>
      decision({ eventId: `evt_test_${index}`, amountMinor: 1 }),
    );
    expect(recoverSwipe(full, attempt, readAt)).toBeNull();
  });
});

describe('purchase orders', () => {
  it('prices a known merchant from the catalog, not the agent’s category', () => {
    const resolved = orderFromRequest({
      merchant: 'Best Buy',
      amount: '19.99',
      description: 'Cable',
      category: 'books',
    });
    expect(resolved).toMatchObject({
      kind: 'order',
      order: { descriptor: 'BESTBUY.COM', mcc: '5732', amountMinor: 1999 },
    });
  });

  it('prices an unknown merchant from its website and declared category', () => {
    const resolved = orderFromRequest({
      merchant: 'Corner Shop',
      merchantUrl: 'https://www.corner-shop.example/item',
      amountMinor: 500,
      description: 'Pens',
      category: 'office_supplies',
    });
    expect(resolved).toMatchObject({
      kind: 'order',
      order: { domain: 'corner-shop.example', descriptor: 'CORNER SHOP', mcc: '5943' },
    });
  });

  it('asks when a name and website disagree', () => {
    expect(
      orderFromRequest({ merchant: 'Amazon', merchantUrl: 'https://bestbuy.com', amount: '1.00', description: 'x' }),
    ).toMatchObject({
      kind: 'clarify',
    });
  });
});

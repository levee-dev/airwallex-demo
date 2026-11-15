import type { PurchaseOutcome } from '../db/schema';
import type { LeveeDecisionRecord, LeveePurchaseResult } from '../levee/types';
import { asRecord } from '../lib/values';
import { issuerFailureCode } from './reasons';

export interface SettledPurchase {
  readonly outcome: PurchaseOutcome;
  readonly reasonCodes: string[];
  readonly challengeId: string | null;
  readonly issuerFailureReason: string | null;
}

/**
 * What one authorization records, read from Levee's purchase answer. Nothing is decided here.
 *
 * - FAILED: the issuer refused a swipe Levee approved. Final; never a challenge.
 * - UNCONFIRMED: the issuer's answer is unknown. Not a decline; the agent must not retry.
 * - A challenge (from the answer, or recovered from Levee's open challenges) needs the person.
 * - A first purchase is never declined for a payee mismatch: that check is the person's approval.
 */
export function settlePurchase(
  result: Pick<
    LeveePurchaseResult,
    'response_status' | 'status_reason' | 'issuer_failure_reason' | 'challenge_id' | 'decision'
  >,
  options: { readonly firstPurchase: boolean; readonly recoveredChallengeId?: string | null },
): SettledPurchase {
  if (result.response_status === 'FAILED') {
    const failure = result.issuer_failure_reason ?? result.status_reason;
    return {
      outcome: 'failed',
      reasonCodes: [issuerFailureCode(failure)],
      challengeId: null,
      issuerFailureReason: failure,
    };
  }
  if (result.response_status === 'UNCONFIRMED') {
    return {
      outcome: 'unconfirmed',
      reasonCodes: ['ISSUER_UNCONFIRMED'],
      challengeId: null,
      issuerFailureReason: null,
    };
  }
  const decision = result.decision;
  let reasons = (
    decision?.reasons?.length ? [...decision.reasons] : decision ? [decision.reasonCode] : [result.status_reason]
  ).filter((code) => code.length > 0);
  if (result.response_status === 'AUTHORIZED') {
    return {
      outcome: 'approved',
      reasonCodes: reasons,
      challengeId: result.challenge_id ?? null,
      issuerFailureReason: null,
    };
  }
  const challengeId = result.challenge_id ?? options.recoveredChallengeId ?? null;
  if (challengeId !== null) {
    return { outcome: 'needs_approval', reasonCodes: reasons, challengeId, issuerFailureReason: null };
  }
  if (options.firstPurchase) {
    reasons = reasons.filter((code) => code.replace(/^LEVEE_/, '') !== 'DECLARATION_PAYEE_MISMATCH');
    if (reasons.length === 0) reasons = ['FIRST_PURCHASE_NOT_SENT'];
  }
  return { outcome: 'declined', reasonCodes: reasons, challengeId: null, issuerFailureReason: null };
}

/** A first-purchase swipe whose answer lost its challenge id: ask Levee for the open challenge. */
export function shouldRecoverChallenge(
  result: Pick<LeveePurchaseResult, 'response_status' | 'challenge_id'>,
  firstPurchase: boolean,
): boolean {
  return firstPurchase && (result.challenge_id ?? null) === null && result.response_status === 'DECLINED';
}

/** What Acme sent for one swipe; a recorded decision must match all of it to settle a timeout. */
export interface SwipeAttempt {
  readonly mandateId: string;
  readonly cardId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly descriptor: string;
  readonly mcc: string;
  readonly startedAtMs: number;
}

export interface RecoveredSwipe {
  readonly result: LeveePurchaseResult;
  readonly latencyMs: number | null;
}

/** How many of the mandate's newest decisions one recovery read asks for. */
export const RECOVERY_PAGE_LIMIT = 50;

const OUTCOMES = new Set(['APPROVE', 'DECLINE', 'CHALLENGE']);
const ISSUER_OUTCOMES = new Set(['AUTHORIZED', 'FAILED', 'REVERSED']);
const optionalString = (value: unknown): value is string | null | undefined =>
  value === undefined || value === null || typeof value === 'string';

/** One `GET /v1/decisions` entry, or null when any field the recovery relies on is malformed. */
export function parseDecision(raw: unknown): LeveeDecisionRecord | null {
  const entry = asRecord(raw);
  const response = asRecord(entry.response);
  const createdAtMs = typeof entry.createdAt === 'string' ? Date.parse(entry.createdAt) : Number.NaN;
  const reasons = entry.reasons ?? [];
  const issuerOutcome = entry.issuerOutcome ?? null;
  const valid =
    typeof entry.eventId === 'string' &&
    optionalString(entry.cardId) &&
    optionalString(entry.mandateId) &&
    typeof entry.outcome === 'string' &&
    OUTCOMES.has(entry.outcome) &&
    Number.isSafeInteger(entry.amountMinor) &&
    typeof entry.currency === 'string' &&
    optionalString(entry.merchantName) &&
    optionalString(entry.mcc) &&
    typeof entry.reasonCode === 'string' &&
    Array.isArray(reasons) &&
    reasons.every((code) => typeof code === 'string') &&
    optionalString(response.status_reason) &&
    optionalString(entry.challengeId) &&
    Number.isFinite(createdAtMs) &&
    (issuerOutcome === null || (typeof issuerOutcome === 'string' && ISSUER_OUTCOMES.has(issuerOutcome))) &&
    optionalString(entry.issuerFailureReason);
  if (!valid) return null;
  return {
    eventId: entry.eventId as string,
    cardId: (entry.cardId as string | null | undefined) ?? null,
    mandateId: (entry.mandateId as string | null | undefined) ?? null,
    outcome: entry.outcome as LeveeDecisionRecord['outcome'],
    amountMinor: entry.amountMinor as number,
    currency: entry.currency as string,
    merchantName: (entry.merchantName as string | null | undefined) ?? null,
    mcc: (entry.mcc as string | null | undefined) ?? null,
    reasonCode: entry.reasonCode as string,
    reasons,
    statusReason: (response.status_reason as string | null | undefined) ?? '',
    challengeId: (entry.challengeId as string | null | undefined) ?? null,
    createdAtMs,
    latencyMs:
      Number.isSafeInteger(entry.latencyMs) && (entry.latencyMs as number) >= 0 ? (entry.latencyMs as number) : null,
    issuerOutcome: issuerOutcome as LeveeDecisionRecord['issuerOutcome'],
    issuerFailureReason: (entry.issuerFailureReason as string | null | undefined) ?? null,
  };
}

const descriptorKey = (value: string): string => value.trim().replace(/\s+/g, ' ').toUpperCase();

/**
 * The answer a timed-out swipe would have had, rebuilt from the one decision Levee recorded for it.
 * Null (the swipe stays unknown) unless exactly one well-formed decision on the page matches this
 * mandate, card, amount and currency inside the swipe's time window, and agrees with its MCC and
 * descriptor where Levee recorded them. A full page whose oldest entry is inside the window may
 * hide older matches, so it never settles anything.
 */
export function recoverSwipe(page: unknown, attempt: SwipeAttempt, readAtMs: number): RecoveredSwipe | null {
  if (!Array.isArray(page)) return null;
  const decisions = page.map(parseDecision);
  if (decisions.some((entry) => entry === null)) return null;
  const parsed = decisions as LeveeDecisionRecord[];
  const inWindow = (entry: LeveeDecisionRecord) =>
    entry.createdAtMs >= attempt.startedAtMs && entry.createdAtMs <= readAtMs;
  const oldest = parsed.reduce<LeveeDecisionRecord | null>(
    (min, entry) => (min === null || entry.createdAtMs < min.createdAtMs ? entry : min),
    null,
  );
  if (parsed.length >= RECOVERY_PAGE_LIMIT && oldest !== null && inWindow(oldest)) return null;
  const matches = parsed.filter(
    (entry) =>
      inWindow(entry) &&
      entry.mandateId === attempt.mandateId &&
      entry.cardId === attempt.cardId &&
      entry.amountMinor === attempt.amountMinor &&
      entry.currency.toUpperCase() === attempt.currency.toUpperCase() &&
      (entry.mcc === null || entry.mcc === attempt.mcc) &&
      (entry.merchantName === null || descriptorKey(entry.merchantName) === descriptorKey(attempt.descriptor)),
  );
  const [match] = matches;
  if (matches.length !== 1 || match === undefined) return null;
  return { result: purchaseResultFrom(match), latencyMs: match.latencyMs };
}

function purchaseResultFrom(decision: LeveeDecisionRecord): LeveePurchaseResult {
  const base = {
    card_transaction_event_id: decision.eventId,
    challenge_id: decision.challengeId,
    decision: { outcome: decision.outcome, reasonCode: decision.reasonCode, reasons: decision.reasons },
  };
  if (decision.outcome !== 'APPROVE') {
    return { ...base, response_status: 'DECLINED', status_reason: decision.statusReason || 'REMOTE_AUTH_DECLINED' };
  }
  switch (decision.issuerOutcome) {
    case 'AUTHORIZED':
      return { ...base, response_status: 'AUTHORIZED', status_reason: decision.statusReason };
    case 'FAILED':
    case 'REVERSED': {
      const reason = decision.issuerFailureReason ?? decision.issuerOutcome;
      return { ...base, response_status: 'FAILED', status_reason: reason, issuer_failure_reason: reason };
    }
    case null:
      return { ...base, response_status: 'UNCONFIRMED', status_reason: 'ISSUER_UNCONFIRMED' };
  }
}

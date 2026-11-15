import { and, eq } from 'drizzle-orm';
import type { Agent } from '../agents/service';
import { openStepUpApproval } from '../approvals/open';
import { openApprovalFor } from '../approvals/store';
import type { User } from '../auth/sessions';
import type { AppContext } from '../context';
import { challenges, purchases, type PurchaseOutcome } from '../db/schema';
import { recordDecline } from '../inbox/service';
import { decryptSecret, newId, randomToken } from '../lib/crypto';
import { AppError } from '../lib/errors';
import { signPayload } from '../levee/agent-signing';
import { LEVEE_TIMEOUT, LeveeError } from '../levee/client';
import type { LeveeChallenge, LeveeDeclarationResult, LeveeMandateView, LeveePurchaseResult } from '../levee/types';
import { categoryForPurchase } from '../mandates/checks';
import {
  freshenBudgets,
  latestMandate,
  liveVersion,
  loadMandate,
  mandateStatus,
  refreshMandate,
  type Mandate,
} from '../mandates/store';
import { categoryByKey, categoryLabel } from '../merchants/catalog';
import { findKnownMerchant } from '../merchants/resolver';
import { replayPendingEvents } from '../webhooks/replay';
import { orderFromRequest, type PurchaseOrder, type PurchaseRequest } from './order';
import {
  RECOVERY_PAGE_LIMIT,
  recoverSwipe,
  settlePurchase,
  shouldRecoverChallenge,
  type RecoveredSwipe,
  type SwipeAttempt,
} from './outcome';
import { plainReason } from './reasons';

export type Purchase = typeof purchases.$inferSelect;

export interface PurchaseResult {
  readonly purchaseId: string;
  readonly status: 'approved' | 'approval_required' | 'declined' | 'unconfirmed';
  readonly reason: string;
  readonly approvalUrl?: string;
  readonly expiresAt?: string;
  readonly summary?: string;
}

export type PurchaseStatus = 'authorized' | 'failed' | 'declined' | 'needs_approval' | 'unconfirmed';

export interface PurchaseStatusView {
  readonly purchaseId: string;
  readonly status: PurchaseStatus;
  readonly reason?: string;
  readonly charged: boolean;
  readonly approvalUrl?: string;
  readonly remainingMinor: number | null;
}

/** Plain reasons for a purchase. On a first purchase the payee check is the person's approval, not a failure. */
export function purchaseReasons(purchase: Pick<Purchase, 'reasonCodes' | 'firstPurchase' | 'outcome'>): string[] {
  return purchase.reasonCodes.map((code) =>
    purchase.firstPurchase && purchase.outcome === 'needs_approval' && code.endsWith('DECLARATION_PAYEE_MISMATCH')
      ? plainReason('FIRST_PURCHASE')
      : plainReason(code),
  );
}

async function resolveOrder(ctx: AppContext, request: PurchaseRequest): Promise<PurchaseOrder> {
  let resolved = orderFromRequest(request);
  const onlyCategoryMissing =
    resolved.kind === 'clarify' &&
    request.category === undefined &&
    request.merchantUrl !== undefined &&
    findKnownMerchant(request.merchant) === undefined &&
    orderFromRequest({ ...request, category: 'marketplace' }).kind === 'order';
  if (onlyCategoryMissing && request.merchantUrl !== undefined) {
    // The model may pick which category Acme declares; Levee still checks it against the mandate.
    const category = await categoryForPurchase(ctx.decisionModel, {
      merchant: request.merchant,
      merchantUrl: request.merchantUrl,
      description: request.description,
    });
    if (category !== null) resolved = orderFromRequest({ ...request, category });
  }
  if (resolved.kind === 'clarify') throw new AppError(422, 'needs_clarification', resolved.question);
  return resolved.order;
}

/**
 * A retry of a purchase whose challenge is still open gets that purchase back: nothing is declared,
 * swiped or charged again. Levee's challenge state decides when it can be read.
 */
async function openRetry(ctx: AppContext, user: User, agent: Agent, mandateId: string, order: PurchaseOrder) {
  const [candidate] = await ctx.db
    .select({ purchase: purchases, challenge: challenges })
    .from(purchases)
    .innerJoin(challenges, eq(challenges.id, purchases.challengeId))
    .where(
      and(
        eq(purchases.agentId, agent.id),
        eq(purchases.mandateId, mandateId),
        eq(purchases.merchantKey, order.merchantKey),
        eq(purchases.amountMinor, order.amountMinor),
        eq(purchases.currency, order.currency),
        eq(purchases.outcome, 'needs_approval'),
        eq(challenges.status, 'pending'),
      ),
    );
  if (candidate === undefined) return null;
  const now = ctx.now().getTime();
  if (candidate.challenge.expiresAt !== null && candidate.challenge.expiresAt.getTime() <= now) return null;
  const open = await openApprovalFor(ctx, user.id, candidate.challenge.id);
  if (open === null) return null;
  try {
    const levee = await ctx.platform.levee();
    const remote = await levee.get<LeveeChallenge>(
      `/v1/challenges/${encodeURIComponent(candidate.challenge.id)}`,
      user.externalRef,
    );
    if (remote.status !== 'PENDING') return null;
  } catch (error) {
    // Levee unreachable: Acme's pending record and live link still say the person has not decided.
    if (!(error instanceof LeveeError)) throw error;
  }
  return { purchase: candidate.purchase, approval: open };
}

/** The challenge a first-purchase swipe opened when Levee's answer lost its id. */
async function findSwipeChallenge(
  ctx: AppContext,
  user: User,
  mandateId: string,
  order: PurchaseOrder,
  sinceMs: number,
) {
  try {
    const levee = await ctx.platform.levee();
    const open = await levee.get<LeveeChallenge[]>('/v1/challenges?status=PENDING', user.externalRef);
    const match = (Array.isArray(open) ? open : [])
      .filter(
        (entry) =>
          entry.mandateId === mandateId &&
          entry.status === 'PENDING' &&
          entry.amountMinor === order.amountMinor &&
          entry.currency === order.currency &&
          Date.parse(entry.createdAt) >= sinceMs - 5_000,
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return match?.id ?? null;
  } catch {
    return null;
  }
}

/** Levee's measured decision time for an authorization; null when it cannot be read. */
async function decisionLatency(ctx: AppContext, user: User, eventId: string): Promise<number | null> {
  try {
    const levee = await ctx.platform.levee();
    const record = await levee.get<{ latencyMs?: unknown }>(
      `/v1/decisions/${encodeURIComponent(eventId)}`,
      user.externalRef,
    );
    return typeof record.latencyMs === 'number' && Number.isSafeInteger(record.latencyMs) && record.latencyMs >= 0
      ? record.latencyMs
      : null;
  } catch (error) {
    if (error instanceof LeveeError) return null;
    throw error;
  }
}

/** One bounded read of the mandate's decisions after a swipe timed out. Never swipes again. */
async function recoverTimedOutSwipe(
  ctx: AppContext,
  user: User,
  attempt: SwipeAttempt,
): Promise<RecoveredSwipe | null> {
  try {
    const levee = await ctx.platform.levee();
    const page = await levee.get<unknown>(
      `/v1/decisions?mandate_id=${encodeURIComponent(attempt.mandateId)}&limit=${RECOVERY_PAGE_LIMIT}`,
      user.externalRef,
    );
    return recoverSwipe(page, attempt, Date.now());
  } catch (error) {
    if (error instanceof LeveeError) return null;
    throw error;
  }
}

interface Swipe {
  readonly result: LeveePurchaseResult;
  readonly recovered: RecoveredSwipe | null;
  readonly startedAtMs: number;
}

async function swipe(
  ctx: AppContext,
  user: User,
  agent: Agent,
  order: PurchaseOrder,
  mandateId: string,
  cardId: string,
): Promise<Swipe> {
  const levee = await ctx.platform.levee();
  const startedAtMs = Date.now();
  try {
    // The sandbox purchase route takes major units; Levee converts back to minor units to decide.
    const result = await levee.post<LeveePurchaseResult>(
      `/v1/agents/${encodeURIComponent(agent.leveeAgentId)}/purchase`,
      {
        merchant: { name: order.descriptor, mcc: order.mcc, country: order.country },
        amount: order.amountMinor / 100,
        currency: order.currency,
      },
      user.externalRef,
    );
    return { result, recovered: null, startedAtMs };
  } catch (error) {
    // A swipe whose answer timed out may still have been decided: read Levee's record of it once.
    const timedOut =
      error instanceof LeveeError &&
      (error.code === LEVEE_TIMEOUT || (error.status === 504 && error.code === 'issuer_timeout'));
    if (!timedOut) throw error;
    const recovered = await recoverTimedOutSwipe(ctx, user, {
      mandateId,
      cardId,
      amountMinor: order.amountMinor,
      currency: order.currency,
      descriptor: order.descriptor,
      mcc: order.mcc,
      startedAtMs,
    });
    if (recovered === null) throw error;
    return { result: recovered.result, recovered, startedAtMs };
  }
}

function resultFor(
  purchase: Purchase,
  approval: { url: string; approval: { expiresAt: Date; shortTitle: string } } | null,
): PurchaseResult {
  const reason = purchaseReasons(purchase).join(' ');
  const status: PurchaseResult['status'] =
    purchase.outcome === 'approved'
      ? 'approved'
      : purchase.outcome === 'unconfirmed'
        ? 'unconfirmed'
        : purchase.outcome === 'needs_approval' && approval !== null
          ? 'approval_required'
          : 'declined';
  if (status !== 'approval_required' || approval === null) return { purchaseId: purchase.id, status, reason };
  return {
    purchaseId: purchase.id,
    status,
    reason,
    approvalUrl: approval.url,
    expiresAt: approval.approval.expiresAt.toISOString(),
    summary: approval.approval.shortTitle,
  };
}

/**
 * The agent buys from a merchant it named. Acme resolves the merchant, signs a declaration with the
 * agent's key and, when Levee allows it, swipes the sandbox card; Levee decides the authorization
 * over Airwallex Remote Authorization. Acme decides nothing about the payment.
 */
export async function purchase(
  ctx: AppContext,
  user: User,
  agent: Agent,
  request: PurchaseRequest,
): Promise<PurchaseResult> {
  const order = await resolveOrder(ctx, request);
  const current = await latestMandate(ctx.db, agent.id);
  if (current === null || mandateStatus(current.versions) !== 'active') {
    throw new AppError(
      409,
      'no_active_mandate',
      'This agent has no active mandate. Ask the person to approve one first.',
    );
  }
  const { mandate } = current;
  const live = liveVersion(current.versions);
  if (live === null) throw new AppError(409, 'no_active_mandate', 'This agent has no active mandate.');
  const levee = await ctx.platform.levee();
  const view = await levee.get<LeveeMandateView>(
    `/v1/mandates/${encodeURIComponent(`${mandate.id}@${live.version}`)}`,
    user.externalRef,
  );
  if (view.card_id === null) throw new AppError(409, 'no_card', 'The card for this agent is not ready yet.');

  const retry = await openRetry(ctx, user, agent, mandate.id, order);
  if (retry !== null) return resultFor(retry.purchase, retry.approval);

  const declaration = {
    agent_id: agent.leveeAgentId,
    mandate_id: mandate.id,
    card_ref: view.card_id,
    payee: { name: order.name, domain: order.domain },
    category: categoryByKey(order.category)?.leveeCategory,
    amount: { currency: order.currency, value: order.amountMinor },
    cart: [{ id: order.merchantKey.slice(0, 128), title: order.item, quantity: 1 }],
    rationale:
      `Acme Pay agent purchase: ${order.item}${order.merchantUrl === undefined ? '' : ` (${order.merchantUrl})`}`.slice(
        0,
        4_000,
      ),
    run_id: randomToken('run_', 8),
    tool_call_id: randomToken('call_', 8),
  };
  const signingKey = decryptSecret(agent.signingKey, ctx.encryptionKey);
  const agentSignature = signPayload(declaration, signingKey, `acme/${agent.leveeAgentId}`);
  const declared = await levee.post<LeveeDeclarationResult>(
    '/v1/declarations',
    { ...declaration, agent_signature: agentSignature },
    user.externalRef,
  );

  const firstPurchase = declared.predicted.learning === true && declared.declaration !== null;
  const base = {
    id: newId('pur'),
    userId: user.id,
    agentId: agent.id,
    mandateId: mandate.id,
    merchantKey: order.merchantKey,
    merchantName: order.name,
    item: order.item,
    amountMinor: order.amountMinor,
    currency: order.currency,
    firstPurchase,
  };
  let values: typeof purchases.$inferInsert;
  if ((declared.predicted.outcome !== 'approve' && !firstPurchase) || declared.declaration === null) {
    const outcome: PurchaseOutcome =
      declared.predicted.outcome === 'challenge' && declared.predicted.challenge_id !== undefined
        ? 'needs_approval'
        : 'declined';
    values = {
      ...base,
      stage: 'declaration',
      outcome,
      reasonCodes: [...declared.predicted.reason_codes],
      challengeId: declared.predicted.challenge_id ?? null,
    };
  } else {
    const { result, recovered, startedAtMs } = await swipe(ctx, user, agent, order, mandate.id, view.card_id);
    const eventId = result.card_transaction_event_id ?? null;
    const recoveredChallengeId =
      recovered === null && shouldRecoverChallenge(result, firstPurchase)
        ? await findSwipeChallenge(ctx, user, mandate.id, order, startedAtMs)
        : null;
    const settled = settlePurchase(result, { firstPurchase, recoveredChallengeId });
    const issuerOutcome =
      result.response_status === 'AUTHORIZED' ? 'AUTHORIZED' : result.response_status === 'FAILED' ? 'FAILED' : null;
    values = {
      ...base,
      stage: 'authorization',
      outcome: settled.outcome,
      reasonCodes: settled.reasonCodes,
      issuerFailureReason: settled.issuerFailureReason,
      issuerEventId: eventId,
      challengeId: settled.challengeId,
      issuerOutcome,
      decisionLatencyMs:
        recovered !== null ? recovered.latencyMs : eventId === null ? null : await decisionLatency(ctx, user, eventId),
    };
  }
  const [record] = await ctx.db.insert(purchases).values(values).returning();
  if (record === undefined) throw new AppError(500, 'internal', 'The purchase could not be recorded.');

  if (record.outcome === 'declined') {
    await recordDecline(ctx.db, {
      userId: user.id,
      mandateId: mandate.id,
      key: record.issuerEventId ?? record.id,
      merchantName: record.merchantName,
      amountMinor: record.amountMinor,
      currency: record.currency,
      reasonCode: record.reasonCodes[0] ?? '',
    });
  }
  const approval =
    record.outcome === 'needs_approval' && record.challengeId !== null
      ? await openChallenge(ctx, mandate, agent, record, order, live.version, view)
      : null;
  await refreshMandate(ctx, user, mandate.id);
  try {
    // An issuer outcome may have arrived before this purchase was recorded; apply it now.
    await replayPendingEvents(ctx);
  } catch (error) {
    // The purchase already happened; a failed replay must not turn its answer into an error.
    if (!(error instanceof LeveeError)) throw error;
  }
  return resultFor(record, approval);
}

/**
 * Records a provisional challenge so the person can act before Levee's `challenge.created` event
 * lands (the event then fills in Levee's own details), and opens the step-up approval.
 */
async function openChallenge(
  ctx: AppContext,
  mandate: Mandate,
  agent: Agent,
  record: Purchase,
  order: PurchaseOrder,
  version: number,
  view: LeveeMandateView,
) {
  const challengeId = record.challengeId;
  if (challengeId === null) return null;
  await ctx.db
    .insert(challenges)
    .values({
      id: challengeId,
      userId: record.userId,
      agentId: agent.id,
      mandateId: mandate.id,
      version,
      merchantName: record.merchantName,
      amountMinor: record.amountMinor,
      currency: record.currency,
      reasonCode: record.reasonCodes[0] ?? 'CHALLENGE_RISK',
      status: 'pending',
      category: categoryLabel(order.category),
      budgetRemainingMinor: view.remaining_minor,
    })
    .onConflictDoNothing();
  return openStepUpApproval(ctx, mandate, agent, {
    version,
    challengeId,
    merchantName: order.name,
    category: categoryLabel(order.category),
    amountMinor: record.amountMinor,
    currency: record.currency,
    budgetRemainingMinor: view.remaining_minor ?? mandate.budget?.remainingMinor ?? null,
    ...(record.firstPurchase
      ? {
          firstPurchase: {
            declared: {
              name: order.name,
              domain: order.domain,
              amountMinor: order.amountMinor,
              currency: order.currency,
            },
            // What Acme's swipe sent; Levee's challenge event replaces it with what Levee observed.
            observed: {
              descriptor: order.descriptor,
              mcc: order.mcc,
              category: categoryLabel(order.category),
              country: order.country,
            },
          },
        }
      : {}),
  });
}

/**
 * The current status of one of this agent's purchases. A late issuer outcome updates the record,
 * so every poll sees the truth. An approval link is returned only while the challenge is open.
 */
export async function purchaseStatus(
  ctx: AppContext,
  user: User,
  agent: Agent,
  purchaseId: string,
): Promise<PurchaseStatusView> {
  const [record] = await ctx.db
    .select()
    .from(purchases)
    .where(and(eq(purchases.id, purchaseId), eq(purchases.agentId, agent.id), eq(purchases.userId, user.id)));
  if (record === undefined) throw new AppError(404, 'not_found', 'Purchase not found.');
  const found = await loadMandate(ctx.db, record.mandateId);
  if (found !== null) await freshenBudgets(ctx, user, [found.mandate]);
  const fresh = found === null ? null : await loadMandate(ctx.db, record.mandateId);
  const base = { purchaseId: record.id, remainingMinor: fresh?.mandate.budget?.remainingMinor ?? null };
  const reason = record.reasonCodes[0] === undefined ? undefined : plainReason(record.reasonCodes[0]);
  switch (record.outcome) {
    case 'approved':
      return { ...base, status: 'authorized', charged: true };
    case 'failed':
      return { ...base, status: 'failed', reason: reason ?? plainReason('ISSUER_DECLINED'), charged: false };
    case 'declined':
      return { ...base, status: 'declined', reason: reason ?? 'The payment was not approved.', charged: false };
    case 'unconfirmed':
      return { ...base, status: 'unconfirmed', reason: plainReason('ISSUER_UNCONFIRMED'), charged: false };
    case 'needs_approval':
      return needsApprovalStatus(ctx, user, record, base);
  }
}

async function needsApprovalStatus(
  ctx: AppContext,
  user: User,
  record: Purchase,
  base: { purchaseId: string; remainingMinor: number | null },
): Promise<PurchaseStatusView> {
  const [challenge] =
    record.challengeId === null
      ? []
      : await ctx.db
          .select()
          .from(challenges)
          .where(and(eq(challenges.id, record.challengeId), eq(challenges.userId, user.id)));
  const waiting = challenge !== undefined && (challenge.status === 'pending' || challenge.status === 'extending');
  const expired = challenge?.expiresAt != null && challenge.expiresAt.getTime() <= ctx.now().getTime();
  // A denial, or a wait that lapsed, is final: report it as declined and never hand out a dead link.
  if (challenge !== undefined && (challenge.status === 'rejected' || (waiting && expired))) {
    const lapsed = challenge.status !== 'rejected' || (challenge.resolution !== 'deny' && expired);
    return {
      ...base,
      status: 'declined',
      reason: plainReason(lapsed ? 'CHALLENGE_EXPIRED' : 'CHALLENGE_REJECTED'),
      charged: false,
    };
  }
  const open = waiting && challenge !== undefined ? await openApprovalFor(ctx, user.id, challenge.id) : null;
  return {
    ...base,
    status: 'needs_approval',
    reason:
      open !== null
        ? 'Waiting for the person to approve this purchase. Nothing has been charged.'
        : 'This approval request is no longer pending. Nothing has been charged.',
    charged: false,
    ...(open === null ? {} : { approvalUrl: open.url }),
  };
}

import { and, eq, isNotNull } from 'drizzle-orm';
import type { Agent } from '../agents/service';
import { openMandateApproval, openResumeApproval, openStepUpApproval } from '../approvals/open';
import { attachFirstPurchase } from '../approvals/store';
import type { FirstPurchaseFacts } from '../approvals/types';
import type { User } from '../auth/sessions';
import type { AppContext } from '../context';
import {
  agents,
  challenges,
  purchases,
  users,
  type ChallengeStatus,
  type VersionStatus,
  type WebhookEnvelope,
} from '../db/schema';
import { addInboxItem, recordDecline } from '../inbox/service';
import type { LeveeChallenge } from '../levee/types';
import { formatMoney } from '../lib/money';
import { expiresIn, notifyInBackground } from '../push/service';
import { asInteger, asRecord, asString } from '../lib/values';
import { loadMandate, refreshMandate, setVersion, type MandateWithVersions } from '../mandates/store';
import { categoryLabelForMcc } from '../merchants/catalog';
import { issuerFailureCode, plainReason } from '../purchases/reasons';

/**
 * Applies one verified Levee event to Acme's mirror. Events signal a change; they are not trusted as
 * state. Mandate and challenge state is re-read from Levee's public API after verification, so a
 * late or replayed delivery cannot restore authority that was taken away.
 *
 * `deferred`: the event concerns a person Acme knows but a record Acme has not written yet (the
 * event beat the API response). It is kept and replayed. `ignored`: nothing here concerns it.
 */
export type ApplyResult = 'applied' | 'deferred' | 'ignored';

interface Owned {
  readonly found: MandateWithVersions;
  readonly user: User;
  readonly agent: Agent;
}

const ENDED: readonly string[] = ['revoked', 'expired', 'superseded', 'exhausted'];
const STATES: readonly string[] = [
  'active',
  'paused',
  'superseded',
  'revoked',
  'expired',
  'exhausted',
  'pending_approval',
];

async function owned(ctx: AppContext, data: Record<string, unknown>): Promise<Owned | null> {
  const mandateId = asString(data.mandate_id);
  if (mandateId === null) return null;
  const found = await loadMandate(ctx.db, mandateId);
  if (found === null) return null;
  const [user] = await ctx.db.select().from(users).where(eq(users.id, found.mandate.userId));
  const [agent] = await ctx.db.select().from(agents).where(eq(agents.id, found.mandate.agentId));
  if (user === undefined || agent === undefined) return null;
  const approverId = asString(data.approver_id);
  if (approverId !== null && approverId !== user.approverId) return null;
  return { found, user, agent };
}

async function knownApprover(ctx: AppContext, data: Record<string, unknown>): Promise<boolean> {
  const approverId = asString(data.approver_id);
  if (approverId === null) return false;
  const rows = await ctx.db.select({ id: users.id }).from(users).where(eq(users.approverId, approverId));
  return rows.length > 0;
}

function challengeState(status: LeveeChallenge['status'], expiresAt: string, now: Date): ChallengeStatus {
  if (status === 'APPROVED') return 'approved';
  if (status === 'PENDING') return Date.parse(expiresAt) > now.getTime() ? 'pending' : 'rejected';
  return 'rejected';
}

async function readChallenge(ctx: AppContext, user: User, challengeId: string): Promise<LeveeChallenge> {
  const levee = await ctx.platform.levee();
  return levee.get<LeveeChallenge>(`/v1/challenges/${encodeURIComponent(challengeId)}`, user.externalRef);
}

export async function applyEvent(ctx: AppContext, envelope: WebhookEnvelope): Promise<ApplyResult> {
  const data = asRecord(envelope.data);
  if (envelope.type === 'kill_switch.engaged') return applyKillSwitch(ctx);
  const target = await owned(ctx, data);
  if (target === null) {
    return (await knownApprover(ctx, data)) ? 'deferred' : 'ignored';
  }
  if (envelope.type === 'mandate.pending_approval') return applyPendingApproval(ctx, target, data);
  if (envelope.type.startsWith('mandate.') || envelope.type.startsWith('freeze.'))
    return applyMandateChange(ctx, target, envelope.type, data);
  switch (envelope.type) {
    case 'challenge.created':
      return applyChallengeCreated(ctx, target, data);
    case 'challenge.approved':
    case 'challenge.rejected':
      return applyChallengeDecided(ctx, target, data);
    case 'issuer.outcome':
      return applyIssuerOutcome(ctx, target, data);
    case 'decision.created':
      return applyDecision(ctx, target, data);
    default:
      return 'ignored';
  }
}

async function applyKillSwitch(ctx: AppContext): Promise<ApplyResult> {
  const people = await ctx.db.select({ id: users.id }).from(users).where(isNotNull(users.approverId));
  for (const person of people) {
    await addInboxItem(ctx.db, {
      userId: person.id,
      type: 'kill_switch.engaged',
      title: 'All agent spending stopped',
      body: 'Agent spending was switched off. Every agent purchase will be declined.',
    });
  }
  return 'applied';
}

async function applyPendingApproval(
  ctx: AppContext,
  { found, agent }: Owned,
  data: Record<string, unknown>,
): Promise<ApplyResult> {
  const version = asInteger(data.version);
  const entry = found.versions.find((candidate) => candidate.version === version);
  if (version === null || entry === undefined) return 'deferred';
  if (entry.status !== 'pending_approval') return 'applied';
  const { approval, url } = await openMandateApproval(ctx, found.mandate, agent, version);
  notifyInBackground(ctx, found.mandate.userId, {
    title: approval.title,
    body: `${agent.name} is asking. Approve with your passkey; the link ${expiresIn(approval.expiresAt, ctx.now())}.`,
    url,
    tag: approval.id,
  });
  await addInboxItem(ctx.db, {
    userId: found.mandate.userId,
    type: 'mandate.pending_approval',
    title: `${agent.name} is asking for approval`,
    body: 'Review the terms and approve with your passkey, or decline.',
    mandateId: found.mandate.id,
  });
  return 'applied';
}

async function applyMandateChange(
  ctx: AppContext,
  target: Owned,
  type: string,
  data: Record<string, unknown>,
): Promise<ApplyResult> {
  const { found, user, agent } = target;
  const { mandate } = found;
  const version = asInteger(data.version) ?? asInteger(data.mandate_version);
  const entry = found.versions.find((candidate) => candidate.version === version);
  if (version === null || entry === undefined) return 'deferred';
  const activationConfirmed = entry.activationConfirmed || type === 'mandate.activated';
  if (activationConfirmed !== entry.activationConfirmed) {
    await setVersion(ctx.db, mandate.id, version, { activationConfirmed }, ctx.now());
  }
  const view = await refreshMandate(ctx, user, `${mandate.id}@${version}`);
  if (!STATES.includes(view.state)) throw new Error('unknown mandate state');
  // The first active state still needs that version's signed activation event.
  const status: VersionStatus =
    view.state === 'revoked' && (data.reason === 'approver_declined' || entry.status === 'declined')
      ? 'declined'
      : view.state === 'active' && !activationConfirmed
        ? 'awaiting_confirmation'
        : (view.state as VersionStatus);
  await setVersion(ctx.db, mandate.id, version, { status, pendingAction: null }, ctx.now());
  if (status === 'paused') await openResumeApproval(ctx, mandate, agent, version);
  if (ENDED.includes(view.state)) await reopenExtendedChallenges(ctx, user, mandate.id, version);
  const refreshed = (await loadMandate(ctx.db, mandate.id))?.mandate ?? mandate;
  await addInboxItem(ctx.db, {
    userId: user.id,
    type,
    title: `${agent.name}: ${status.replaceAll('_', ' ')}`,
    body:
      refreshed.freezeStatus === 'frozen'
        ? 'The issuer confirmed the card is frozen.'
        : refreshed.freezeStatus === 'failed'
          ? 'The card freeze is not confirmed. Spending authority is revoked.'
          : status === 'active'
            ? 'Your signed terms are active. The virtual card is ready.'
            : status === 'revoked'
              ? 'Spending authority is revoked.'
              : 'Your spending controls were updated.',
    mandateId: mandate.id,
  });
  return 'applied';
}

/**
 * Declining or losing an "allow from now on" extension does not resolve the purchase that asked
 * for it. Reopen exactly that attempt, from Levee's current challenge state.
 */
async function reopenExtendedChallenges(
  ctx: AppContext,
  user: User,
  mandateId: string,
  version: number,
): Promise<void> {
  const extended = await ctx.db
    .select()
    .from(challenges)
    .where(
      and(
        eq(challenges.mandateId, mandateId),
        eq(challenges.extensionVersion, version),
        eq(challenges.status, 'extending'),
      ),
    );
  for (const challenge of extended) {
    const current = await readChallenge(ctx, user, challenge.id);
    if (current.mandateId !== mandateId) throw new Error('extension challenge identity mismatch');
    const status = challengeState(current.status, current.expiresAt, ctx.now());
    await ctx.db
      .update(challenges)
      .set({ status, expiresAt: new Date(current.expiresAt), ...(status === 'pending' ? { resolution: null } : {}) })
      .where(eq(challenges.id, challenge.id));
  }
}

function firstPurchaseFacts(data: Record<string, unknown>): FirstPurchaseFacts | undefined {
  if (data.learning !== true) return undefined;
  const text = (value: unknown) => {
    const result = asString(value);
    return result !== null && result.length <= 200 ? result : null;
  };
  const payee = asRecord(data.declared_payee);
  const amount = asRecord(data.declared_amount);
  const observed = asRecord(data.observed);
  const facts = {
    name: text(payee.name),
    domain: text(payee.domain),
    currency: text(amount.currency),
    value: asInteger(amount.value),
    descriptor: text(observed.descriptor),
    mcc: text(observed.mcc),
    category: text(observed.mcc_category),
    country: text(observed.country),
  };
  if (Object.values(facts).some((value) => value === null)) return undefined;
  return {
    declared: {
      name: facts.name ?? '',
      domain: facts.domain ?? '',
      amountMinor: facts.value ?? 0,
      currency: facts.currency ?? '',
    },
    observed: {
      descriptor: facts.descriptor ?? '',
      mcc: facts.mcc ?? '',
      category: facts.category ?? '',
      country: facts.country ?? '',
    },
  };
}

async function applyChallengeCreated(
  ctx: AppContext,
  target: Owned,
  data: Record<string, unknown>,
): Promise<ApplyResult> {
  const { found, user, agent } = target;
  const { mandate } = found;
  const challengeId = asString(data.challenge_id);
  const version = asInteger(data.version) ?? asInteger(data.mandate_version);
  if (challengeId === null || version === null) return 'ignored';
  const current = await readChallenge(ctx, user, challengeId);
  if (current.mandateId !== mandate.id) return 'ignored';
  const state = challengeState(current.status, current.expiresAt, ctx.now());
  const amountMinor = asInteger(data.amount_minor) ?? 0;
  const currency = asString(data.currency) ?? 'USD';
  const merchantName = asString(data.merchant_name) ?? 'a merchant';
  const mcc = asString(data.mcc);
  const category = mcc === null ? 'Purchase' : categoryLabelForMcc(mcc);
  const [previous] = await ctx.db.select().from(challenges).where(eq(challenges.id, challengeId));
  const budgetRemainingMinor =
    previous?.budgetRemainingMinor ??
    (state === 'pending' ? (await refreshMandate(ctx, user, `${mandate.id}@${version}`)).remaining_minor : null);
  const values = {
    userId: user.id,
    agentId: agent.id,
    mandateId: mandate.id,
    version,
    merchantName,
    amountMinor,
    currency,
    reasonCode: asString(data.reason_code) ?? 'CHALLENGE_RISK',
    status: state === 'pending' && previous?.status === 'extending' ? ('extending' as const) : state,
    category,
    budgetRemainingMinor,
    expiresAt: new Date(current.expiresAt),
  };
  await ctx.db
    .insert(challenges)
    .values({ id: challengeId, ...values })
    .onConflictDoUpdate({ target: challenges.id, set: values });
  const firstPurchase = firstPurchaseFacts(data);
  if (firstPurchase !== undefined) await attachFirstPurchase(ctx, challengeId, firstPurchase);
  if (state === 'pending') {
    const { approval, url } = await openStepUpApproval(ctx, mandate, agent, {
      version,
      challengeId,
      merchantName,
      category,
      amountMinor,
      currency,
      budgetRemainingMinor,
      ...(firstPurchase === undefined ? {} : { firstPurchase }),
    });
    notifyInBackground(ctx, user.id, {
      title: `${agent.name} needs your OK`,
      body: `${approval.title}. The link ${expiresIn(approval.expiresAt, ctx.now())}.`,
      url,
      tag: approval.id,
    });
  }
  await addInboxItem(ctx.db, {
    userId: user.id,
    type: 'challenge.created',
    title: state === 'pending' ? `${agent.name} needs your OK` : `${agent.name}: purchase request ${state}`,
    body: `${formatMoney(amountMinor, currency)} at ${merchantName}. ${plainReason(asString(data.reason_code) ?? 'CHALLENGE_RISK')}`,
    mandateId: mandate.id,
    challengeId,
  });
  return 'applied';
}

async function applyChallengeDecided(
  ctx: AppContext,
  target: Owned,
  data: Record<string, unknown>,
): Promise<ApplyResult> {
  const { user, agent, found } = target;
  const challengeId = asString(data.challenge_id);
  if (challengeId === null) return 'ignored';
  const [challenge] = await ctx.db
    .select()
    .from(challenges)
    .where(and(eq(challenges.id, challengeId), eq(challenges.userId, user.id)));
  if (challenge === undefined) return 'deferred';
  const current = await readChallenge(ctx, user, challengeId);
  if (current.mandateId !== found.mandate.id) return 'ignored';
  const state = challengeState(current.status, current.expiresAt, ctx.now());
  await ctx.db.update(challenges).set({ status: state }).where(eq(challenges.id, challengeId));
  const approved = state === 'approved';
  await addInboxItem(ctx.db, {
    userId: user.id,
    type: approved ? 'challenge.approved' : 'challenge.rejected',
    title: `${approved ? 'Allowed' : 'Declined'}: ${challenge.merchantName}`,
    body: approved
      ? challenge.resolution === 'allow_from_now_on'
        ? 'Your new terms are active.'
        : `Allowed once. ${agent.name} can retry the purchase.`
      : 'Nothing was charged.',
    mandateId: found.mandate.id,
    challengeId,
  });
  return 'applied';
}

async function applyIssuerOutcome(ctx: AppContext, target: Owned, data: Record<string, unknown>): Promise<ApplyResult> {
  const { found, user } = target;
  const eventId = asString(data.event_id);
  const outcome = asString(data.outcome);
  if (eventId === null || (outcome !== 'AUTHORIZED' && outcome !== 'FAILED' && outcome !== 'REVERSED'))
    return 'ignored';
  await refreshMandate(ctx, user, found.mandate.id);
  const [purchase] = await ctx.db
    .select()
    .from(purchases)
    .where(and(eq(purchases.issuerEventId, eventId), eq(purchases.mandateId, found.mandate.id)));
  // The purchase may still be being recorded; keep the event and replay it.
  if (purchase === undefined) return 'deferred';
  // FAILED and REVERSED are final; an older AUTHORIZED delivery must not turn the charge back on.
  if (purchase.issuerOutcome === 'FAILED' || purchase.issuerOutcome === 'REVERSED') return 'applied';
  const failureReason = outcome === 'FAILED' ? asString(data.failure_reason) : null;
  await ctx.db
    .update(purchases)
    .set(
      outcome === 'AUTHORIZED'
        ? {
            issuerOutcome: outcome,
            outcome: 'approved',
            reasonCodes: purchase.reasonCodes.filter((code) => code !== 'ISSUER_UNCONFIRMED'),
            issuerFailureReason: null,
          }
        : {
            issuerOutcome: outcome,
            outcome: 'failed',
            issuerFailureReason: failureReason,
            reasonCodes: [outcome === 'REVERSED' ? 'ISSUER_REVERSED' : issuerFailureCode(failureReason)],
          },
    )
    .where(eq(purchases.id, purchase.id));
  return 'applied';
}

async function applyDecision(ctx: AppContext, target: Owned, data: Record<string, unknown>): Promise<ApplyResult> {
  const { found, user } = target;
  const eventId = asString(data.event_id);
  await refreshMandate(ctx, user, found.mandate.id);
  const [purchase] =
    eventId === null ? [] : await ctx.db.select().from(purchases).where(eq(purchases.issuerEventId, eventId));
  const reasons = Array.isArray(data.reason_codes)
    ? data.reason_codes.filter((code): code is string => typeof code === 'string')
    : [];
  if (purchase !== undefined && reasons.length > 0) {
    await ctx.db.update(purchases).set({ reasonCodes: reasons }).where(eq(purchases.id, purchase.id));
  }
  const amountMinor = purchase?.amountMinor ?? asInteger(data.amount_minor) ?? 0;
  const currency = purchase?.currency ?? asString(data.currency) ?? 'USD';
  const merchantName = purchase?.merchantName ?? asString(data.merchant_name) ?? 'Merchant';
  if (asString(data.outcome) === 'DECLINE') {
    await recordDecline(ctx.db, {
      userId: user.id,
      mandateId: found.mandate.id,
      key: eventId ?? purchase?.id ?? '',
      merchantName,
      amountMinor,
      currency,
      reasonCode: asString(data.reason_code) ?? '',
    });
    return 'applied';
  }
  if (asString(data.outcome) === 'APPROVE') {
    await addInboxItem(ctx.db, {
      userId: user.id,
      type: 'decision.created',
      title: `Paid ${formatMoney(amountMinor, currency)}`,
      body: `${merchantName}: ${plainReason(asString(data.reason_code) ?? '')}`,
      mandateId: found.mandate.id,
      ...(eventId === null ? {} : { dedupeKey: `paid:${eventId}` }),
    });
  }
  return 'applied';
}

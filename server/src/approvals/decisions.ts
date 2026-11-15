import { eq } from 'drizzle-orm';
import type { User } from '../auth/sessions';
import {
  allowFromNowOn,
  allowFromNowOnOptions,
  allowOnce,
  allowOnceOptions,
  denyChallenge,
} from '../challenges/service';
import type { AppContext } from '../context';
import { agents, users, type ApprovalStatus } from '../db/schema';
import { AppError } from '../lib/errors';
import {
  approveMandate,
  approveOptions,
  declineMandate,
  resumeMandate,
  resumeOptions,
  type CeremonyOptions,
} from '../mandates/decisions';
import { loadMandate } from '../mandates/store';
import { approvalForToken, claimApproval, finishApproval, releaseApproval, type Approval } from './store';

export const ACTIONS = ['approve', 'decline', 'allow-once', 'allow-from-now-on', 'deny'] as const;
export type ApprovalAction = (typeof ACTIONS)[number];

export function isApprovalAction(value: unknown): value is ApprovalAction {
  return typeof value === 'string' && (ACTIONS as readonly string[]).includes(value);
}

export function allowedActions(approval: Approval): readonly ApprovalAction[] {
  if (approval.kind !== 'step_up') return ['approve', 'decline'];
  // A first purchase is approved once; "from now on" would widen the mandate to an unverified shop.
  return approval.firstPurchase === null ? ['allow-once', 'allow-from-now-on', 'deny'] : ['allow-once', 'deny'];
}

async function ownerOf(ctx: AppContext, approval: Approval): Promise<User> {
  const [user] = await ctx.db.select().from(users).where(eq(users.id, approval.userId));
  if (user === undefined) throw new AppError(404, 'link_not_found', 'This approval link is not valid.');
  return user;
}

async function forAction(ctx: AppContext, token: string, action: ApprovalAction) {
  const approval = await approvalForToken(ctx, token);
  if (!allowedActions(approval).includes(action)) {
    throw new AppError(400, 'invalid_action', 'That action is not available for this approval.');
  }
  return { approval, user: await ownerOf(ctx, approval) };
}

function challengeOf(approval: Approval): string {
  if (approval.challengeId === null) throw new AppError(409, 'invalid_state', 'This link has no open purchase.');
  return approval.challengeId;
}

function versionOf(approval: Approval): number {
  if (approval.version === null) throw new AppError(409, 'invalid_state', 'This link has no mandate version.');
  return approval.version;
}

/** Starts the passkey ceremony for an action. The ceremony is bound to this approval and action. */
export async function decisionOptions(
  ctx: AppContext,
  token: string,
  action: ApprovalAction,
): Promise<CeremonyOptions> {
  const { approval, user } = await forAction(ctx, token, action);
  const binding = { approvalId: approval.id, action };
  switch (action) {
    case 'approve':
      return approval.kind === 'resume'
        ? resumeOptions(ctx, user, approval.mandateId, binding)
        : approveOptions(ctx, user, approval.mandateId, versionOf(approval), binding);
    case 'allow-once':
      return allowOnceOptions(ctx, user, challengeOf(approval), binding);
    case 'allow-from-now-on':
      return allowFromNowOnOptions(ctx, user, challengeOf(approval), binding);
    default:
      throw new AppError(400, 'invalid_action', 'Declining does not need a passkey.');
  }
}

const RESULT: Readonly<Record<ApprovalAction, ApprovalStatus>> = {
  approve: 'approved',
  decline: 'declined',
  'allow-once': 'allowed_once',
  'allow-from-now-on': 'allowed_from_now_on',
  deny: 'denied',
};

/**
 * Carries out the person's decision. The approval is claimed first, so a second device can never
 * decide it too; if Levee refuses, the claim is released and the link still works.
 */
export async function decide(
  ctx: AppContext,
  token: string,
  action: ApprovalAction,
  body: { readonly requestId?: unknown; readonly response?: unknown },
): Promise<{ status: ApprovalStatus; decidedAt: string }> {
  const { approval, user } = await forAction(ctx, token, action);
  await claimApproval(ctx, approval);
  const binding = { approvalId: approval.id, action };
  const ceremony = { requestId: body.requestId, response: body.response, binding };
  try {
    switch (action) {
      case 'approve':
        if (approval.kind === 'resume') await resumeMandate(ctx, user, { mandateId: approval.mandateId, ...ceremony });
        else
          await approveMandate(ctx, user, { mandateId: approval.mandateId, version: versionOf(approval), ...ceremony });
        break;
      case 'decline':
        // Declining a resume leaves the mandate paused; it must never revoke it.
        if (approval.kind === 'mandate') await declineMandate(ctx, user, approval.mandateId, versionOf(approval));
        break;
      case 'allow-once':
        await allowOnce(ctx, user, { challengeId: challengeOf(approval), ...ceremony });
        break;
      case 'allow-from-now-on':
        await allowFromNowOn(ctx, user, { challengeId: challengeOf(approval), ...ceremony });
        break;
      case 'deny':
        await denyChallenge(ctx, user, challengeOf(approval));
        break;
    }
  } catch (error) {
    await releaseApproval(ctx, approval.id);
    throw error;
  }
  const status = RESULT[action];
  const decidedAt = await finishApproval(ctx, approval.id, status);
  return { status, decidedAt: decidedAt.toISOString() };
}

/** What the approval page shows. Reading a link does not use it up. */
export async function approvalPage(ctx: AppContext, token: string) {
  const approval = await approvalForToken(ctx, token);
  const user = await ownerOf(ctx, approval);
  const found = await loadMandate(ctx.db, approval.mandateId);
  const [agent] = await ctx.db.select().from(agents).where(eq(agents.id, approval.agentId));
  if (found === null || agent === undefined)
    throw new AppError(404, 'link_not_found', 'This approval link is not valid.');
  const { mandate, versions } = found;
  const version = versions.find((entry) => entry.version === approval.version);
  const remaining = approval.budgetRemainingMinor ?? mandate.budget?.remainingMinor ?? mandate.terms.totalMinor;
  return {
    kind: approval.kind,
    title: approval.title,
    shortTitle: approval.shortTitle,
    expiresAt: approval.expiresAt.toISOString(),
    agent: { name: agent.name, client: agent.client },
    approverHint: `${user.email.slice(0, Math.min(3, user.email.indexOf('@')))}…`,
    intentQuote: approval.intentQuote,
    merchant:
      approval.merchantName === null ? null : { name: approval.merchantName, category: approval.merchantCategory },
    amount:
      approval.amountMinor === null ? null : { minor: approval.amountMinor, currency: approval.currency ?? 'USD' },
    budget: {
      currency: mandate.terms.currency,
      totalMinor: mandate.terms.totalMinor,
      remainingMinor: remaining,
      perPurchaseCapMinor: mandate.terms.perPurchaseCapMinor,
      validUntil: mandate.terms.validUntil,
      categories: mandate.terms.categories,
    },
    overByMinor:
      approval.kind === 'step_up' && approval.amountMinor !== null
        ? Math.max(0, approval.amountMinor - remaining)
        : null,
    preview: approval.kind === 'mandate' ? (version?.approval ?? null) : null,
    firstPurchase: approval.firstPurchase,
    allowedActions: allowedActions(approval),
  };
}

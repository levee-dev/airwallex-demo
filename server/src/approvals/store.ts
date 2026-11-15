import { and, desc, eq, gt, inArray, lte } from 'drizzle-orm';
import type { AppContext } from '../context';
import { approvals, type ApprovalKind, type ApprovalStatus } from '../db/schema';
import { decryptSecret, encryptSecret, newId, randomToken, sha256Hex } from '../lib/crypto';
import { AppError } from '../lib/errors';
import type { FirstPurchaseFacts } from './types';

export type Approval = typeof approvals.$inferSelect;

/** Approval links are single-use and last fifteen minutes. */
export const APPROVAL_TTL_MS = 15 * 60_000;
const TOKEN_PATTERN = /^apr_[A-Za-z0-9_-]{20,}$/;
const OPEN: ApprovalStatus[] = ['pending', 'deciding'];

export interface ApprovalInput {
  readonly userId: string;
  readonly agentId: string;
  readonly mandateId: string;
  readonly kind: ApprovalKind;
  readonly target: string;
  readonly version: number | null;
  readonly challengeId: string | null;
  readonly title: string;
  readonly shortTitle: string;
  readonly intentQuote: string | null;
  readonly merchant?: { readonly name: string; readonly category: string };
  readonly amountMinor?: number;
  readonly currency: string;
  readonly budgetRemainingMinor: number | null;
  readonly firstPurchase?: FirstPurchaseFacts;
}

export interface OpenApproval {
  readonly approval: Approval;
  readonly url: string;
}

export function approvalUrl(ctx: AppContext, approval: Approval): string {
  return `${ctx.publicUrl}/approve/${decryptSecret(approval.tokenEncrypted, ctx.encryptionKey)}`;
}

/** The open approval for this target, or a new one with a fresh link. Never two open at once. */
export async function ensureApproval(ctx: AppContext, input: ApprovalInput): Promise<OpenApproval> {
  const now = ctx.now();
  await expireStale(ctx, input.userId);
  const [existing] = await ctx.db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.userId, input.userId),
        eq(approvals.kind, input.kind),
        eq(approvals.target, input.target),
        inArray(approvals.status, OPEN),
      ),
    );
  if (existing !== undefined) return { approval: existing, url: approvalUrl(ctx, existing) };
  const token = randomToken('apr_', 32);
  const [created] = await ctx.db
    .insert(approvals)
    .values({
      id: newId('apv'),
      userId: input.userId,
      agentId: input.agentId,
      mandateId: input.mandateId,
      kind: input.kind,
      target: input.target,
      version: input.version,
      challengeId: input.challengeId,
      title: input.title,
      shortTitle: input.shortTitle,
      intentQuote: input.intentQuote,
      merchantName: input.merchant?.name ?? null,
      merchantCategory: input.merchant?.category ?? null,
      amountMinor: input.amountMinor ?? null,
      currency: input.currency,
      budgetRemainingMinor: input.budgetRemainingMinor,
      firstPurchase: input.firstPurchase ?? null,
      tokenHash: sha256Hex(token),
      tokenEncrypted: encryptSecret(token, ctx.encryptionKey),
      expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS),
    })
    .onConflictDoNothing()
    .returning();
  if (created !== undefined) return { approval: created, url: `${ctx.publicUrl}/approve/${token}` };
  // A concurrent request opened the same approval first; use it.
  return ensureApproval(ctx, input);
}

async function expireStale(ctx: AppContext, userId: string): Promise<void> {
  await ctx.db
    .update(approvals)
    .set({ status: 'expired' })
    .where(and(eq(approvals.userId, userId), inArray(approvals.status, OPEN), lte(approvals.expiresAt, ctx.now())));
}

/** The approval a link opens. Throws a plain error for an unknown, expired or used link. */
export async function approvalForToken(ctx: AppContext, token: string): Promise<Approval> {
  const notFound = new AppError(404, 'link_not_found', 'This approval link is not valid.');
  if (!TOKEN_PATTERN.test(token)) throw notFound;
  const [approval] = await ctx.db
    .select()
    .from(approvals)
    .where(eq(approvals.tokenHash, sha256Hex(token)));
  if (approval === undefined) throw notFound;
  if (approval.status === 'expired' || approval.expiresAt.getTime() <= ctx.now().getTime()) {
    await ctx.db
      .update(approvals)
      .set({ status: 'expired' })
      .where(and(eq(approvals.id, approval.id), inArray(approvals.status, OPEN)));
    throw new AppError(410, 'link_expired', 'This approval link has expired. Ask the agent to send a new one.');
  }
  if (approval.status !== 'pending') {
    throw new AppError(410, 'link_used', 'This approval link was already used. Ask the agent to send a new one.');
  }
  return approval;
}

/** Atomically claims a pending approval so two devices can never both decide it. */
export async function claimApproval(ctx: AppContext, approval: Approval): Promise<void> {
  const claimed = await ctx.db
    .update(approvals)
    .set({ status: 'deciding' })
    .where(and(eq(approvals.id, approval.id), eq(approvals.status, 'pending'), gt(approvals.expiresAt, ctx.now())))
    .returning({ id: approvals.id });
  if (claimed.length === 0) {
    throw new AppError(410, 'link_used', 'This approval link was already used. Ask the agent to send a new one.');
  }
}

/** Returns a claimed approval to pending after a decision failed, so the link still works. */
export async function releaseApproval(ctx: AppContext, approvalId: string): Promise<void> {
  await ctx.db
    .update(approvals)
    .set({ status: 'pending' })
    .where(and(eq(approvals.id, approvalId), eq(approvals.status, 'deciding')));
}

export async function finishApproval(ctx: AppContext, approvalId: string, status: ApprovalStatus): Promise<Date> {
  const decidedAt = ctx.now();
  await ctx.db.update(approvals).set({ status, decidedAt }).where(eq(approvals.id, approvalId));
  return decidedAt;
}

/** The newest still-open approval for a target, with its link. */
export async function openApprovalFor(ctx: AppContext, userId: string, target: string): Promise<OpenApproval | null> {
  const [approval] = await ctx.db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.userId, userId),
        eq(approvals.target, target),
        eq(approvals.status, 'pending'),
        gt(approvals.expiresAt, ctx.now()),
      ),
    )
    .orderBy(desc(approvals.createdAt))
    .limit(1);
  return approval === undefined ? null : { approval, url: approvalUrl(ctx, approval) };
}

export async function openApprovalsForUser(ctx: AppContext, userId: string): Promise<OpenApproval[]> {
  const rows = await ctx.db
    .select()
    .from(approvals)
    .where(and(eq(approvals.userId, userId), eq(approvals.status, 'pending'), gt(approvals.expiresAt, ctx.now())))
    .orderBy(desc(approvals.createdAt));
  return rows.map((approval) => ({ approval, url: approvalUrl(ctx, approval) }));
}

/** The newest approval of any status for a target; the request status reads its outcome. */
export async function latestApprovalFor(ctx: AppContext, userId: string, target: string): Promise<Approval | null> {
  const [approval] = await ctx.db
    .select()
    .from(approvals)
    .where(and(eq(approvals.userId, userId), eq(approvals.target, target)))
    .orderBy(desc(approvals.createdAt))
    .limit(1);
  return approval ?? null;
}

export async function attachFirstPurchase(
  ctx: AppContext,
  challengeId: string,
  facts: FirstPurchaseFacts,
): Promise<void> {
  await ctx.db
    .update(approvals)
    .set({ firstPurchase: facts })
    .where(and(eq(approvals.kind, 'step_up'), eq(approvals.target, challengeId)));
}

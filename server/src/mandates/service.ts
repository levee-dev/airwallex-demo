import { and, desc, eq } from 'drizzle-orm';
import { requireApprover } from '../accounts/provisioning';
import type { Agent } from '../agents/service';
import { openMandateApproval, openResumeApproval } from '../approvals/open';
import { latestApprovalFor, openApprovalFor } from '../approvals/store';
import type { User } from '../auth/sessions';
import type { AppContext } from '../context';
import { mandateRequests, mandateVersions, mandates } from '../db/schema';
import { newId } from '../lib/crypto';
import { AppError } from '../lib/errors';
import type { LeveeCreatedMandate } from '../levee/types';
import { replayPendingEvents } from '../webhooks/replay';
import { buildApprovalView } from './approval-view';
import { checkMandateRequest } from './checks';
import { draftMandate, type MandateRequest } from './draft';
import {
  isLive,
  latestMandate,
  liveVersion,
  loadMandate,
  mandateForUser,
  mandateStatus,
  setVersion,
  termsFromCreated,
  versionStatusLabel,
} from './store';

export type RequestStatus = 'awaiting_approval' | 'approved' | 'declined' | 'expired';

export interface MandateRequestResult {
  readonly requestId: string;
  readonly status: 'awaiting_approval';
  readonly approvalUrl: string;
  readonly expiresAt: string;
  readonly summary: string;
}

function clarify(question: string): AppError {
  return new AppError(422, 'needs_clarification', question);
}

/**
 * An agent asks for a spending mandate. Acme builds the draft from the typed fields, the optional
 * decision model may stop it, Levee records it as pending, and the person gets an approval link.
 */
export async function requestMandate(
  ctx: AppContext,
  user: User,
  agent: Agent,
  request: MandateRequest,
): Promise<MandateRequestResult> {
  const approverId = requireApprover(user);
  const now = ctx.now();
  const draft = draftMandate({ request, leveeAgentId: agent.leveeAgentId, approverId, now });
  if (draft.kind === 'clarify') throw clarify(draft.question);
  const current = await latestMandate(ctx.db, agent.id);
  if (current !== null && isLive(mandateStatus(current.versions))) {
    throw new AppError(
      409,
      'agent_has_mandate',
      `This agent already has a mandate. The person can revoke it at ${ctx.publicUrl}/dashboard before you ask for a new one.`,
    );
  }
  const days = Math.max(1, Math.round((Date.parse(draft.notAfter) - now.getTime()) / 86_400_000));
  const outcome = await checkMandateRequest(ctx.decisionModel, {
    purpose: request.purpose,
    capMinor: request.capMinor,
    categories: draft.categories,
    merchants: request.merchants ?? [],
    windowText: `${days} day${days === 1 ? '' : 's'}, until ${draft.notAfter.slice(0, 10)}`,
  });
  if (outcome.kind === 'refuse') throw new AppError(422, 'request_refused', outcome.reason);
  if (outcome.kind === 'clarify') throw clarify(outcome.question);

  const levee = await ctx.platform.levee();
  const created = await levee.post<LeveeCreatedMandate>('/v1/mandates', draft.body, user.externalRef);
  const approval = buildApprovalView({
    created,
    fields: draft.fields,
    notes: draft.notes,
    riskNotes: outcome.riskNotes,
    checks: outcome.checks,
  });
  const requestId = newId('mrq');
  const mandate = await ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(mandates)
      .values({
        id: created.id,
        userId: user.id,
        agentId: agent.id,
        intent: request.purpose,
        terms: termsFromCreated(created),
      })
      .returning();
    await tx
      .insert(mandateVersions)
      .values({ mandateId: created.id, version: created.version, status: 'pending_approval', approval });
    await tx
      .insert(mandateRequests)
      .values({ id: requestId, agentId: agent.id, mandateId: created.id, version: created.version });
    return row;
  });
  if (mandate === undefined) throw new AppError(500, 'internal', 'The mandate could not be saved.');
  const { approval: open, url } = await openMandateApproval(ctx, mandate, agent, created.version);
  await replayPendingEvents(ctx);
  return {
    requestId,
    status: 'awaiting_approval',
    approvalUrl: url,
    expiresAt: open.expiresAt.toISOString(),
    summary: open.shortTitle,
  };
}

/** The outcome of a mandate request, plus its approval link while the person can still decide. */
export async function requestStatus(
  ctx: AppContext,
  user: User,
  agent: Agent,
  requestId: string,
): Promise<{ status: RequestStatus; approvalUrl?: string; expiresAt?: string }> {
  const [request] = await ctx.db
    .select()
    .from(mandateRequests)
    .where(and(eq(mandateRequests.id, requestId), eq(mandateRequests.agentId, agent.id)));
  if (request === undefined) throw new AppError(404, 'not_found', 'No such request for this agent.');
  const found = await loadMandate(ctx.db, request.mandateId);
  const version = found?.versions.find((entry) => entry.version === request.version);
  switch (version?.status) {
    case 'active':
    case 'paused':
      return { status: 'approved' };
    case 'declined':
      return { status: 'declined' };
    case 'revoked':
    case 'expired':
    case 'exhausted':
    case 'superseded':
      return { status: 'expired' };
    default:
      break;
  }
  const target = `${request.mandateId}@${request.version}`;
  const latest = await latestApprovalFor(ctx, user.id, target);
  if (latest?.status === 'approved') return { status: 'approved' };
  if (latest?.status === 'declined') return { status: 'declined' };
  const open = await openApprovalFor(ctx, user.id, target);
  if (open === null) return { status: latest === null ? 'awaiting_approval' : 'expired' };
  return { status: 'awaiting_approval', approvalUrl: open.url, expiresAt: open.approval.expiresAt.toISOString() };
}

/** The agent's mandates, newest first, for the agent's own view over MCP. */
export async function mandatesForAgent(ctx: AppContext, agent: Agent) {
  const rows = await ctx.db
    .select()
    .from(mandates)
    .where(eq(mandates.agentId, agent.id))
    .orderBy(desc(mandates.createdAt))
    .limit(10);
  const result = [];
  for (const mandate of rows) {
    const found = await loadMandate(ctx.db, mandate.id);
    const live = found === null ? null : liveVersion(found.versions);
    result.push({
      mandate_id: mandate.id,
      status: live === null ? 'pending' : versionStatusLabel(live.status),
      purpose: mandate.terms.purpose,
      currency: mandate.terms.currency,
      total_minor: mandate.terms.totalMinor,
      remaining_minor: mandate.budget?.remainingMinor ?? null,
      valid_until: mandate.terms.validUntil,
    });
  }
  return result;
}

function liveReference(versions: Parameters<typeof liveVersion>[0], mandateId: string, allowed: readonly string[]) {
  const live = liveVersion(versions);
  if (live === null || !allowed.includes(live.status)) {
    throw new AppError(409, 'invalid_state', 'This mandate cannot do that right now.');
  }
  return { reference: `${mandateId}@${live.version}`, version: live.version };
}

/** Pauses spending at once. Resuming needs the person's passkey, through a resume approval. */
export async function pauseMandate(ctx: AppContext, user: User, agent: Agent, mandateId: string): Promise<void> {
  const { mandate, versions } = await mandateForUser(ctx.db, user, mandateId);
  const { reference, version } = liveReference(versions, mandate.id, ['active']);
  const levee = await ctx.platform.levee();
  await levee.post(`/v1/mandates/${encodeURIComponent(reference)}/pause`, { requested_via: 'app' }, user.externalRef);
  await setVersion(ctx.db, mandate.id, version, { pendingAction: 'pause' }, ctx.now());
  await openResumeApproval(ctx, mandate, agent, version);
}

/** Revokes spending authority on the person's instruction; Levee then freezes the card. */
export async function revokeMandate(ctx: AppContext, user: User, mandateId: string): Promise<void> {
  const { mandate, versions } = await mandateForUser(ctx.db, user, mandateId);
  const { reference, version } = liveReference(versions, mandate.id, ['active', 'paused']);
  const levee = await ctx.platform.levee();
  await levee.post(`/v1/mandates/${encodeURIComponent(reference)}/revoke`, { requested_via: 'app' }, user.externalRef);
  await setVersion(ctx.db, mandate.id, version, { pendingAction: 'revoke' }, ctx.now());
  if (mandate.cardLast4 !== null && mandate.freezeStatus === 'none') {
    await ctx.db.update(mandates).set({ freezeStatus: 'requested' }).where(eq(mandates.id, mandate.id));
  }
}

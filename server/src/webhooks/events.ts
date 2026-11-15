import { and, asc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import type { AppContext } from '../context';
import { webhookEvents, type WebhookEnvelope } from '../db/schema';

/** The event types Acme subscribes to on its Levee webhook endpoint. */
export const WEBHOOK_EVENT_TYPES = [
  'mandate.pending_approval',
  'mandate.activated',
  'mandate.paused',
  'mandate.resumed',
  'mandate.superseded',
  'mandate.revoked',
  'challenge.created',
  'challenge.approved',
  'challenge.rejected',
  'decision.created',
  'issuer.outcome',
  'kill_switch.engaged',
  'freeze.confirmed',
  'freeze.failed',
] as const;

/** A claim older than this belongs to a crashed attempt and may be taken over. */
const CLAIM_TIMEOUT_MS = 60_000;
export const MAX_PENDING_EVENTS = 1_000;

/**
 * Claims an event for applying. Returns false when it is processed, ignored, or being applied by
 * another delivery right now.
 */
export async function claimEvent(ctx: AppContext, eventId: string): Promise<boolean> {
  const now = ctx.now();
  const stale = new Date(now.getTime() - CLAIM_TIMEOUT_MS);
  const claimed = await ctx.db
    .update(webhookEvents)
    .set({ status: 'applying', claimedAt: now })
    .where(
      and(
        eq(webhookEvents.eventId, eventId),
        or(
          eq(webhookEvents.status, 'pending'),
          and(eq(webhookEvents.status, 'applying'), lt(webhookEvents.claimedAt, stale)),
        ),
      ),
    )
    .returning({ eventId: webhookEvents.eventId });
  return claimed.length > 0;
}

export async function settleEvent(
  ctx: AppContext,
  eventId: string,
  status: 'pending' | 'processed' | 'ignored',
): Promise<void> {
  await ctx.db
    .update(webhookEvents)
    .set({ status, claimedAt: null, processedAt: status === 'pending' ? null : ctx.now() })
    .where(eq(webhookEvents.eventId, eventId));
}

/** Records a verified delivery. Returns false when the event id was seen before. */
export async function recordEvent(ctx: AppContext, envelope: WebhookEnvelope): Promise<boolean> {
  const inserted = await ctx.db
    .insert(webhookEvents)
    .values({ eventId: envelope.event_id, type: envelope.type, payload: envelope, status: 'pending' })
    .onConflictDoNothing()
    .returning({ eventId: webhookEvents.eventId });
  return inserted.length > 0;
}

export async function pendingEventCount(ctx: AppContext): Promise<number> {
  const [row] = await ctx.db
    .select({ count: sql<number>`count(*)::int` })
    .from(webhookEvents)
    .where(inArray(webhookEvents.status, ['pending', 'applying']));
  return row?.count ?? 0;
}

export async function pendingEvents(ctx: AppContext): Promise<WebhookEnvelope[]> {
  const rows = await ctx.db
    .select({ payload: webhookEvents.payload })
    .from(webhookEvents)
    .where(eq(webhookEvents.status, 'pending'))
    .orderBy(asc(webhookEvents.receivedAt))
    .limit(100);
  return rows.map((row) => row.payload);
}

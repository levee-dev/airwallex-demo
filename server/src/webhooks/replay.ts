import type { AppContext } from '../context';
import type { WebhookEnvelope } from '../db/schema';
import { applyEvent } from './apply';
import { claimEvent, pendingEvents, settleEvent } from './events';

/** Applies one recorded event under a claim. Returns what happened, or null if another worker holds it. */
export async function processEvent(ctx: AppContext, envelope: WebhookEnvelope) {
  if (!(await claimEvent(ctx, envelope.event_id))) return null;
  try {
    const result = await applyEvent(ctx, envelope);
    await settleEvent(
      ctx,
      envelope.event_id,
      result === 'applied' ? 'processed' : result === 'deferred' ? 'pending' : 'ignored',
    );
    return result;
  } catch (error) {
    await settleEvent(ctx, envelope.event_id, 'pending');
    throw error;
  }
}

/** Replays events that arrived before the records they describe. Called after Acme writes such records. */
export async function replayPendingEvents(ctx: AppContext): Promise<void> {
  for (const envelope of await pendingEvents(ctx)) await processEvent(ctx, envelope);
}

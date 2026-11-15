import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../db/client';
import { inboxItems } from '../db/schema';
import { newId } from '../lib/crypto';
import { formatMoney } from '../lib/money';
import { plainReason } from '../purchases/reasons';

export interface InboxEntry {
  readonly userId: string;
  readonly type: string;
  readonly title: string;
  readonly body: string;
  readonly mandateId?: string;
  readonly challengeId?: string;
  /** Entries sharing a key are recorded once. */
  readonly dedupeKey?: string;
}

export async function addInboxItem(db: Database, entry: InboxEntry): Promise<void> {
  await db
    .insert(inboxItems)
    .values({
      id: newId('inb'),
      userId: entry.userId,
      type: entry.type,
      title: entry.title,
      body: entry.body,
      mandateId: entry.mandateId ?? null,
      challengeId: entry.challengeId ?? null,
      dedupeKey: entry.dedupeKey ?? null,
    })
    .onConflictDoNothing();
}

/**
 * One notice per declined purchase, whether the purchase answer or Levee's decision event lands
 * first. Both key it by the issuer event id when there is one, else by Acme's purchase id.
 */
export function recordDecline(
  db: Database,
  decline: {
    readonly userId: string;
    readonly mandateId: string;
    readonly key: string;
    readonly merchantName: string;
    readonly amountMinor: number;
    readonly currency: string;
    readonly reasonCode: string;
  },
): Promise<void> {
  return addInboxItem(db, {
    userId: decline.userId,
    type: 'purchase.declined',
    title: `Declined ${formatMoney(decline.amountMinor, decline.currency)}`,
    body: `${decline.merchantName}: ${plainReason(decline.reasonCode)}`,
    mandateId: decline.mandateId,
    dedupeKey: `decline:${decline.key}`,
  });
}

export async function listInbox(db: Database, userId: string) {
  return db
    .select()
    .from(inboxItems)
    .where(eq(inboxItems.userId, userId))
    .orderBy(desc(inboxItems.createdAt))
    .limit(50);
}

export async function markRead(db: Database, userId: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(inboxItems)
    .set({ read: true })
    .where(and(eq(inboxItems.userId, userId), inArray(inboxItems.id, [...ids])));
}

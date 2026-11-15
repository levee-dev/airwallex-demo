import { and, asc, eq } from 'drizzle-orm';
import type { AppContext, PushTarget, VapidKeys } from '../context';
import { pushSubscriptions } from '../db/schema';
import { newId } from '../lib/crypto';
import { AppError } from '../lib/errors';
import { asRecord, asString } from '../lib/values';

/**
 * Approval notifications on the person's phone over Web Push. The browser subscribes with the
 * platform's VAPID public key; Acme stores the subscription and sends each approval link to it.
 * Push is a convenience: the approval link and the dashboard work without it, so a failed send is
 * logged and never blocks anything.
 */

export interface PushMessage {
  readonly title: string;
  readonly body: string;
  /** Opened when the notification is tapped. Always an Acme Pay URL. */
  readonly url: string;
  /** Notifications with the same tag replace each other on the device. */
  readonly tag: string;
}

export interface PushDevice {
  readonly id: string;
  readonly label: string;
  readonly createdAt: string;
}

const MAX_ENDPOINT_LENGTH = 1_000;
const KEY = /^[A-Za-z0-9_-]{16,200}={0,2}$/;

/** A readable name for the device a subscription came from, from its User-Agent. */
export function deviceLabel(userAgent: string | null): string {
  const ua = userAgent ?? '';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  if (/Macintosh|Mac OS X/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/CrOS/.test(ua)) return 'Chromebook';
  if (/Linux/.test(ua)) return 'Linux computer';
  return 'this browser';
}

/** The platform's VAPID keys, or null when `acme setup` has not generated them yet. */
export async function vapidKeys(ctx: AppContext): Promise<VapidKeys | null> {
  const { vapid } = await ctx.platform.credentials();
  if (vapid === null) return null;
  // Push services want a way to reach the sender. Apple refuses a localhost subject.
  const subject = ctx.publicUrl.startsWith('https:') ? ctx.publicUrl : 'mailto:push@acme-pay.example';
  return { subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey };
}

/** Validates a browser `PushSubscription.toJSON()`. */
export function parseSubscription(value: unknown): PushTarget {
  const record = asRecord(value);
  const endpoint = asString(record.endpoint);
  const keys = asRecord(record.keys);
  const p256dh = asString(keys.p256dh);
  const auth = asString(keys.auth);
  let url: URL | null;
  try {
    url = endpoint === null ? null : new URL(endpoint);
  } catch {
    url = null;
  }
  if (
    endpoint === null ||
    url?.protocol !== 'https:' ||
    endpoint.length > MAX_ENDPOINT_LENGTH ||
    p256dh === null ||
    auth === null ||
    !KEY.test(p256dh) ||
    !KEY.test(auth)
  ) {
    throw new AppError(400, 'invalid_subscription', 'The browser sent an invalid push subscription.');
  }
  return { endpoint, keys: { p256dh, auth } };
}

export async function listDevices(ctx: AppContext, userId: string): Promise<PushDevice[]> {
  const rows = await ctx.db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId))
    .orderBy(asc(pushSubscriptions.createdAt));
  return rows.map((row) => ({
    id: row.id,
    label: deviceLabel(row.userAgent),
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function hasPushSubscription(ctx: AppContext, userId: string): Promise<boolean> {
  const rows = await ctx.db
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId))
    .limit(1);
  return rows.length > 0;
}

/** Stores a subscription. An endpoint is one browser, so re-subscribing moves it to this person. */
export async function saveSubscription(
  ctx: AppContext,
  userId: string,
  target: PushTarget,
  userAgent: string | null,
): Promise<PushDevice> {
  const values = { userId, keys: { ...target.keys }, userAgent: userAgent?.slice(0, 400) ?? null };
  const [row] = await ctx.db
    .insert(pushSubscriptions)
    .values({ id: newId('psh'), endpoint: target.endpoint, ...values })
    .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: values })
    .returning();
  if (row === undefined) throw new AppError(500, 'internal', 'The subscription could not be saved.');
  return { id: row.id, label: deviceLabel(row.userAgent), createdAt: row.createdAt.toISOString() };
}

export async function removeSubscription(ctx: AppContext, userId: string, endpoint: string): Promise<void> {
  await ctx.db
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)));
}

/** The push service's HTTP status on a refused send, when it gave one. */
function pushStatus(error: unknown): number | null {
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === 'number' ? status : null;
}

export interface PushResult {
  readonly sent: number;
  readonly failed: number;
  /** Subscriptions the push service said are gone (404/410), now deleted. */
  readonly removed: number;
}

/** Sends to every subscription the person has. Gone subscriptions are deleted. */
export async function notifyUser(ctx: AppContext, userId: string, message: PushMessage): Promise<PushResult> {
  const rows = await ctx.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
  if (rows.length === 0) return { sent: 0, failed: 0, removed: 0 };
  const vapid = await vapidKeys(ctx);
  if (vapid === null) return { sent: 0, failed: rows.length, removed: 0 };
  const payload = JSON.stringify(message);
  let sent = 0;
  let failed = 0;
  let removed = 0;
  for (const row of rows) {
    try {
      await ctx.push.send({ endpoint: row.endpoint, keys: row.keys }, payload, vapid);
      sent += 1;
    } catch (error) {
      const status = pushStatus(error);
      if (status === 404 || status === 410) {
        await ctx.db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, row.id));
        removed += 1;
      } else {
        failed += 1;
      }
    }
  }
  return { sent, failed, removed };
}

/** Fire and forget: the caller never waits for, or fails because of, a push. */
export function notifyInBackground(ctx: AppContext, userId: string, message: PushMessage): void {
  void notifyUser(ctx, userId, message).catch((error: unknown) => {
    console.error('push notification failed', error instanceof Error ? error.name : 'unknown');
  });
}

/** "expires in 15 min" for a notification body. */
export function expiresIn(expiresAt: Date, now: Date): string {
  const minutes = Math.max(1, Math.round((expiresAt.getTime() - now.getTime()) / 60_000));
  if (minutes < 120) return `expires in ${minutes} min`;
  return `expires in ${Math.round(minutes / 60)} h`;
}

import { sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import { rateLimits } from '../db/schema';

export interface RateLimitRule {
  readonly max: number;
  readonly windowMs: number;
}

export const RATE_LIMITS = {
  signupPerIp: { max: 30, windowMs: 60 * 60_000 },
  signupPerEmail: { max: 5, windowMs: 60 * 60_000 },
  loginPerIp: { max: 60, windowMs: 5 * 60_000 },
  loginPerEmail: { max: 10, windowMs: 5 * 60_000 },
  approvalPerIp: { max: 120, windowMs: 5 * 60_000 },
} as const satisfies Readonly<Record<string, RateLimitRule>>;

/**
 * Fixed-window limiter kept in Postgres, so limits hold across restarts and instances. Every
 * attempt counts, successful or not. Returns 0 when allowed, else the seconds until the window ends.
 */
export async function consumeRateLimit(db: Database, key: string, rule: RateLimitRule, now: Date): Promise<number> {
  const windowStartCutoff = new Date(now.getTime() - rule.windowMs);
  const [row] = await db
    .insert(rateLimits)
    .values({ key, windowStart: now, count: 1 })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        windowStart: sql`case when ${rateLimits.windowStart} <= ${windowStartCutoff} then ${now} else ${rateLimits.windowStart} end`,
        count: sql`case when ${rateLimits.windowStart} <= ${windowStartCutoff} then 1 else ${rateLimits.count} + 1 end`,
      },
    })
    .returning({ windowStart: rateLimits.windowStart, count: rateLimits.count });
  if (row === undefined || row.count <= rule.max) return 0;
  return Math.max(1, Math.ceil((row.windowStart.getTime() + rule.windowMs - now.getTime()) / 1000));
}

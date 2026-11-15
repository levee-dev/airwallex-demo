import { and, eq, gt, lt } from 'drizzle-orm';
import type { Database } from '../db/client';
import { sessions, users } from '../db/schema';
import { randomToken, sha256Hex } from '../lib/crypto';

export const SESSION_COOKIE = 'acme_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type User = typeof users.$inferSelect;

export interface Session {
  readonly user: User;
  readonly csrfToken: string;
}

/**
 * Creates a session. The raw token goes only into the httpOnly cookie; the database keeps its
 * SHA-256 hash. The CSRF token is returned to the app, which echoes it on every unsafe request.
 */
export async function createSession(
  db: Database,
  userId: string,
  now: Date,
): Promise<{ token: string; csrfToken: string; expiresAt: Date }> {
  const token = randomToken('', 32);
  const csrfToken = randomToken('', 24);
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await db.insert(sessions).values({ tokenHash: sha256Hex(token), userId, csrfToken, expiresAt });
  return { token, csrfToken, expiresAt };
}

export async function findSession(db: Database, token: string, now: Date): Promise<Session | null> {
  if (token.length < 20 || token.length > 200) return null;
  const [row] = await db
    .select({ user: users, csrfToken: sessions.csrfToken })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, sha256Hex(token)), gt(sessions.expiresAt, now)));
  return row ?? null;
}

export async function deleteSession(db: Database, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, sha256Hex(token)));
}

export async function deleteExpiredSessions(db: Database, now: Date): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, now));
}

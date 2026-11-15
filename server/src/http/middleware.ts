import type { Context, MiddlewareHandler } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { getCookie } from 'hono/cookie';
import { SESSION_COOKIE, findSession, type Session } from '../auth/sessions';
import { consumeRateLimit, type RateLimitRule } from '../auth/rate-limit';
import type { AppContext } from '../context';
import { AppError } from '../lib/errors';
import { safeEqual } from '../lib/crypto';
import { isRecord } from '../lib/values';

export interface AppEnv {
  Variables: { session: Session };
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Browser routes accept unsafe requests only from the app's own origin, as JSON. Together with the
 * SameSite cookie and the session-bound CSRF token this closes cross-site request forgery.
 */
export function sameOriginJson(ctx: AppContext): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (UNSAFE.has(c.req.method)) {
      if (c.req.header('origin') !== ctx.publicUrl)
        throw new AppError(403, 'origin_rejected', 'Request origin is not allowed.');
      if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) {
        throw new AppError(415, 'json_required', 'Send JSON.');
      }
    }
    await next();
  };
}

/** Requires a signed-in user; unsafe requests also need the session's CSRF token. */
export function requireSession(ctx: AppContext): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    const session = token === undefined ? null : await findSession(ctx.db, token, ctx.now());
    if (session === null) throw new AppError(401, 'signed_out', 'Sign in to continue.');
    if (UNSAFE.has(c.req.method)) {
      const csrf = c.req.header('x-csrf-token');
      if (csrf === undefined || !safeEqual(csrf, session.csrfToken)) {
        throw new AppError(403, 'csrf_rejected', 'Refresh the page and try again.');
      }
    }
    c.set('session', session);
    await next();
  };
}

export async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await c.req.json();
  } catch {
    throw new AppError(400, 'invalid_json', 'Send a JSON object.');
  }
  if (!isRecord(parsed)) throw new AppError(400, 'invalid_json', 'Send a JSON object.');
  return parsed;
}

/**
 * The client address for rate limits. Behind a trusted proxy it is the rightmost
 * `x-forwarded-for` hop (the one the proxy appended); otherwise the socket peer.
 */
export function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const hops = (c.req.header('x-forwarded-for') ?? '').split(',').map((hop) => hop.trim());
    const last = hops.at(-1);
    if (last !== undefined && last.length > 0) return last;
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function enforceRateLimit(
  ctx: AppContext,
  c: Context,
  attempts: readonly { readonly key: string; readonly rule: RateLimitRule }[],
): Promise<void> {
  for (const attempt of attempts) {
    const retryAfter = await consumeRateLimit(ctx.db, attempt.key, attempt.rule, ctx.now());
    if (retryAfter > 0) {
      c.header('retry-after', String(retryAfter));
      throw new AppError(429, 'rate_limited', 'Too many attempts. Wait a moment and try again.');
    }
  }
}

export function requiredText(body: Record<string, unknown>, field: string, max: number): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new AppError(400, 'invalid_request', `${field} is required (up to ${max} characters).`);
  }
  return value.trim();
}

/** Limits requests per client address on a route group. */
export function rateLimitByIp(ctx: AppContext, prefix: string, rule: RateLimitRule): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await enforceRateLimit(ctx, c, [{ key: `${prefix}:ip:${clientIp(c, ctx.trustProxy)}`, rule }]);
    await next();
  };
}

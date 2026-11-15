import { eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { accountView, resumeProvisioning, startProvisioning } from '../accounts/provisioning';
import type { AppContext } from '../context';
import { users } from '../db/schema';
import { clientIp, enforceRateLimit, jsonBody, requireSession, requiredText, type AppEnv } from '../http/middleware';
import { newId, randomToken } from '../lib/crypto';
import { AppError } from '../lib/errors';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  hashPassword,
  isValidEmail,
  normalizeEmail,
  verifyPassword,
} from '../lib/passwords';
import { RATE_LIMITS } from './rate-limit';
import { SESSION_COOKIE, SESSION_TTL_MS, createSession, deleteSession, type User } from './sessions';

/** What the web app shows about the person beyond the user row; wired up in `createApp`. */
export interface UserFlags {
  readonly hasPasskey: boolean;
  /** At least one browser is subscribed to approval notifications. */
  readonly phoneNotifications: boolean;
}

export type UserFlagsReader = (userId: string) => Promise<UserFlags>;

export function publicUser(user: User, flags: UserFlags) {
  return {
    id: user.id,
    email: user.email,
    name: user.displayName,
    hasPasskey: flags.hasPasskey,
    phoneNotifications: flags.phoneNotifications,
    account: accountView(user),
  };
}

function credentials(body: Record<string, unknown>): { email: string; password: string } {
  const email = normalizeEmail(requiredText(body, 'email', 254));
  if (!isValidEmail(email)) throw new AppError(400, 'invalid_email', 'Enter a valid email address.');
  const password = body.password;
  if (typeof password !== 'string' || password.length === 0 || password.length > PASSWORD_MAX_LENGTH) {
    throw new AppError(400, 'invalid_password', 'Enter your password.');
  }
  return { email, password };
}

export function authRoutes(ctx: AppContext, userFlags: UserFlagsReader) {
  const app = new Hono<AppEnv>();

  const startSession = async (c: Context, user: User) => {
    const session = await createSession(ctx.db, user.id, ctx.now());
    setCookie(c, SESSION_COOKIE, session.token, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: ctx.secureCookies,
      path: '/',
      maxAge: SESSION_TTL_MS / 1000,
    });
    return c.json({ csrfToken: session.csrfToken, user: publicUser(user, await userFlags(user.id)) });
  };

  app.post('/signup', async (c) => {
    const body = await jsonBody(c);
    const { email, password } = credentials(body);
    const name = requiredText(body, 'name', 80);
    const ip = clientIp(c, ctx.trustProxy);
    await enforceRateLimit(ctx, c, [
      { key: `signup:ip:${ip}`, rule: RATE_LIMITS.signupPerIp },
      { key: `signup:email:${email}`, rule: RATE_LIMITS.signupPerEmail },
    ]);
    if (password.length < PASSWORD_MIN_LENGTH) {
      throw new AppError(400, 'weak_password', `Use at least ${PASSWORD_MIN_LENGTH} characters.`);
    }
    const [user] = await ctx.db
      .insert(users)
      .values({
        id: newId('usr'),
        email,
        passwordHash: await hashPassword(password),
        displayName: name,
        externalRef: randomToken('eu_', 16),
      })
      .onConflictDoNothing({ target: users.email })
      .returning();
    if (user === undefined) throw new AppError(409, 'email_taken', 'An account with this email already exists.');
    // The card account opens in the background while the person carries on with setup.
    void startProvisioning(ctx, user.id);
    return startSession(c, user);
  });

  app.post('/login', async (c) => {
    const { email, password } = credentials(await jsonBody(c));
    const ip = clientIp(c, ctx.trustProxy);
    await enforceRateLimit(ctx, c, [
      { key: `login:ip:${ip}`, rule: RATE_LIMITS.loginPerIp },
      { key: `login:email:${email}`, rule: RATE_LIMITS.loginPerEmail },
    ]);
    const [user] = await ctx.db.select().from(users).where(eq(users.email, email));
    const valid = await verifyPassword(password, user?.passwordHash ?? null);
    if (user === undefined || !valid) throw new AppError(401, 'invalid_credentials', 'Email or password is incorrect.');
    return startSession(c, user);
  });

  app.post('/logout', requireSession(ctx), async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token !== undefined) await deleteSession(ctx.db, token);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ signedOut: true });
  });

  app.get('/me', requireSession(ctx), async (c) => {
    const { user, csrfToken } = c.get('session');
    resumeProvisioning(ctx, user);
    return c.json({ csrfToken, user: publicUser(user, await userFlags(user.id)) });
  });

  return app;
}

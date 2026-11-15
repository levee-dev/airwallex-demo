import { Hono } from 'hono';
import { publicUser, type UserFlagsReader } from '../auth/routes';
import type { AppContext } from '../context';
import { requireSession, type AppEnv } from '../http/middleware';
import { accountView, resumeProvisioning, retryProvisioning } from './provisioning';

/**
 * The person's card account. It opens in the background from sign-up; these routes only report its
 * status and let the person retry after a failure.
 */
export function accountRoutes(ctx: AppContext, userFlags: UserFlagsReader) {
  const app = new Hono<AppEnv>();
  app.use('*', requireSession(ctx));

  /** The account status (opening, ready or failed). Reading it resumes a run that was cut short. */
  app.get('/', (c) => {
    const { user } = c.get('session');
    resumeProvisioning(ctx, user);
    return c.json({ account: accountView(user) });
  });

  /** Starts provisioning again after a failure, from wherever the last run stopped. Safe to repeat. */
  app.post('/provision', async (c) => {
    const user = await retryProvisioning(ctx, c.get('session').user);
    return c.json({ user: publicUser(user, await userFlags(user.id)) });
  });

  return app;
}

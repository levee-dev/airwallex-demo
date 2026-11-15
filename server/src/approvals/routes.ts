import { Hono } from 'hono';
import { RATE_LIMITS } from '../auth/rate-limit';
import type { AppContext } from '../context';
import { jsonBody, rateLimitByIp, type AppEnv } from '../http/middleware';
import { AppError } from '../lib/errors';
import { approvalPage, decide, decisionOptions, isApprovalAction } from './decisions';

/**
 * The approval page API. The link token is the capability to view and to start a passkey ceremony;
 * only the owner's passkey, verified by Levee, can approve. No session is needed, so the person can
 * open the link on any device.
 */
export function approvalRoutes(ctx: AppContext) {
  const app = new Hono<AppEnv>();

  app.use('*', rateLimitByIp(ctx, 'approval', RATE_LIMITS.approvalPerIp));

  app.get('/:token', async (c) => c.json(await approvalPage(ctx, c.req.param('token'))));

  app.post('/:token/options', async (c) => {
    const { action } = await jsonBody(c);
    if (!isApprovalAction(action)) throw new AppError(400, 'invalid_action', 'Choose an action.');
    return c.json(await decisionOptions(ctx, c.req.param('token'), action));
  });

  app.post('/:token/:action', async (c) => {
    const action = c.req.param('action');
    if (!isApprovalAction(action)) throw new AppError(404, 'not_found', 'Unknown action.');
    const body = await jsonBody(c);
    return c.json(
      await decide(ctx, c.req.param('token'), action, { requestId: body.requestId, response: body.response }),
    );
  });

  return app;
}

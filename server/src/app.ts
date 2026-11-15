import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { accountRoutes } from './accounts/routes';
import { agentRoutes } from './agents/routes';
import { approvalRoutes } from './approvals/routes';
import { authRoutes } from './auth/routes';
import type { AppContext } from './context';
import { dashboardRoutes } from './dashboard/routes';
import { sameOriginJson, type AppEnv } from './http/middleware';
import { AppError } from './lib/errors';
import { LeveeError } from './levee/client';
import { mcpRoutes } from './mcp/routes';
import { hasPasskey, passkeyRoutes } from './passkeys/routes';
import { pushRoutes } from './push/routes';
import { hasPushSubscription } from './push/service';
import { webhookRoutes } from './webhooks/routes';

const MAX_JSON_BYTES = 64 * 1024;

/** The HTTP surface: the web app's API, the approval page API, MCP for agents and Levee webhooks. */
export function createApp(ctx: AppContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.onError((error, c) => {
    if (error instanceof AppError) {
      return c.json({ error: error.code, message: error.message, ...error.extra }, error.status as 400);
    }
    if (error instanceof LeveeError) {
      const status = error.status >= 500 || error.status === 401 ? 502 : error.status;
      return c.json({ error: error.code, message: error.message, source: 'levee' }, status as 400);
    }
    console.error('unhandled error', error instanceof Error ? error.name : 'unknown');
    return c.json({ error: 'internal', message: 'Something went wrong. Try again.' }, 500);
  });

  app.use('*', secureHeaders({ referrerPolicy: 'no-referrer' }));
  app.use('/api/*', async (c, next) => {
    await next();
    c.header('cache-control', 'no-store');
  });
  app.use(
    '/api/*',
    bodyLimit({
      maxSize: MAX_JSON_BYTES,
      onError: (c) => c.json({ error: 'too_large', message: 'Request is too large.' }, 413),
    }),
  );
  app.use('/api/*', sameOriginJson(ctx));

  app.get('/api/health', (c) => c.json({ ok: true }));
  const userFlags = async (userId: string) => ({
    hasPasskey: await hasPasskey(ctx, userId),
    phoneNotifications: await hasPushSubscription(ctx, userId),
  });
  app.route('/api/auth', authRoutes(ctx, userFlags));
  app.route('/api/account', accountRoutes(ctx, userFlags));
  app.route('/api/passkeys', passkeyRoutes(ctx));
  app.route('/api/push', pushRoutes(ctx));
  app.route('/api/agents', agentRoutes(ctx));
  app.route('/api/approvals', approvalRoutes(ctx));
  app.route('/api', dashboardRoutes(ctx));
  app.route('/mcp', mcpRoutes(ctx));
  app.route('/webhooks', webhookRoutes(ctx));
  app.all('/api/*', (c) => c.json({ error: 'not_found', message: 'No such route.' }, 404));

  return app;
}

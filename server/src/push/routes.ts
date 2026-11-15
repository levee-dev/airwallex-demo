import { Hono } from 'hono';
import type { AppContext } from '../context';
import { enforceRateLimit, jsonBody, requireSession, type AppEnv } from '../http/middleware';
import { AppError } from '../lib/errors';
import { asString } from '../lib/values';
import { listDevices, notifyUser, parseSubscription, removeSubscription, saveSubscription, vapidKeys } from './service';

const TEST_RULE = { max: 10, windowMs: 10 * 60_000 } as const;

/** Phone notifications for approvals: the VAPID key to subscribe with, the person's devices, a test. */
export function pushRoutes(ctx: AppContext) {
  const app = new Hono<AppEnv>();
  app.use('*', requireSession(ctx));

  /**
   * `publicUrl` is the app's public origin from the server's config. The phone step shows it as a QR
   * code, since the page may be open on a different origin (localhost) than the one a phone reaches.
   */
  app.get('/', async (c) => {
    const { user } = c.get('session');
    const vapid = await vapidKeys(ctx);
    return c.json({
      configured: vapid !== null,
      publicKey: vapid?.publicKey ?? null,
      publicUrl: ctx.publicUrl,
      devices: await listDevices(ctx, user.id),
    });
  });

  app.post('/subscriptions', async (c) => {
    const { user } = c.get('session');
    if ((await vapidKeys(ctx)) === null) {
      throw new AppError(
        503,
        'push_not_configured',
        'Phone notifications are not set up. The operator runs `npm run setup`.',
      );
    }
    const body = await jsonBody(c);
    const device = await saveSubscription(
      ctx,
      user.id,
      parseSubscription(body.subscription),
      c.req.header('user-agent') ?? null,
    );
    return c.json({ device, devices: await listDevices(ctx, user.id) }, 201);
  });

  app.post('/subscriptions/remove', async (c) => {
    const { user } = c.get('session');
    const endpoint = asString((await jsonBody(c)).endpoint);
    if (endpoint === null) throw new AppError(400, 'endpoint_required', 'The subscription endpoint is required.');
    await removeSubscription(ctx, user.id, endpoint);
    return c.json({ devices: await listDevices(ctx, user.id) });
  });

  app.post('/test', async (c) => {
    const { user } = c.get('session');
    await enforceRateLimit(ctx, c, [{ key: `push-test:${user.id}`, rule: TEST_RULE }]);
    const result = await notifyUser(ctx, user.id, {
      title: 'Acme Pay notifications are on',
      body: 'Approval requests from your agent will show up here.',
      url: `${ctx.publicUrl}/dashboard`,
      tag: 'acme-test',
    });
    if (result.sent === 0) {
      throw new AppError(
        409,
        'push_not_delivered',
        result.removed > 0
          ? 'This device is no longer subscribed. Allow notifications again.'
          : 'No device received it. Allow notifications on your phone first.',
      );
    }
    return c.json({ ...result, devices: await listDevices(ctx, user.id) });
  });

  return app;
}

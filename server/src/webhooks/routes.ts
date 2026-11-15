import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppContext } from '../context';
import { MAX_WEBHOOK_BYTES, receiveWebhook } from './receiver';

/** `POST /webhooks/levee`: the endpoint the operator registers in Levee. */
export function webhookRoutes(ctx: AppContext) {
  const app = new Hono();
  app.post(
    '/levee',
    bodyLimit({ maxSize: MAX_WEBHOOK_BYTES, onError: (c) => c.json({ error: 'too_large' }, 413) }),
    async (c) => {
      const receipt = await receiveWebhook(ctx, await c.req.text(), {
        signature: c.req.header('levee-signature'),
        eventId: c.req.header('levee-event-id'),
      });
      return c.json(receipt.body, receipt.status as 200);
    },
  );
  return app;
}

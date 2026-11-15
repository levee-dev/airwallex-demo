import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { approverFor } from '../accounts/provisioning';
import type { AppContext } from '../context';
import { passkeys } from '../db/schema';
import { jsonBody, requireSession, type AppEnv } from '../http/middleware';
import { newId } from '../lib/crypto';
import { AppError } from '../lib/errors';
import { isRecord } from '../lib/values';
import { finishCeremony, startCeremony } from './ceremonies';

export async function hasPasskey(ctx: AppContext, userId: string): Promise<boolean> {
  const rows = await ctx.db.select({ id: passkeys.id }).from(passkeys).where(eq(passkeys.userId, userId)).limit(1);
  return rows.length > 0;
}

/**
 * Passkey enrolment. Levee is the WebAuthn relying party: it issues the registration options and
 * verifies the browser's response. Acme only relays them and records that the user has a passkey.
 */
export function passkeyRoutes(ctx: AppContext) {
  const app = new Hono<AppEnv>();
  app.use('*', requireSession(ctx));

  app.post('/options', async (c) => {
    const { user } = c.get('session');
    // The approver exists before the card account is ready, so the passkey never waits for it.
    const approverId = await approverFor(ctx, user);
    const levee = await ctx.platform.levee();
    const result = await levee.post<{ request_id: string; options: unknown }>(
      `/v1/approvers/${encodeURIComponent(approverId)}/passkeys/options`,
      { label: 'Acme Pay passkey' },
      user.externalRef,
    );
    await startCeremony(ctx.db, {
      userId: user.id,
      requestId: result.request_id,
      kind: 'register',
      target: approverId,
      now: ctx.now(),
    });
    return c.json({ requestId: result.request_id, options: result.options });
  });

  app.post('/', async (c) => {
    const { user } = c.get('session');
    const approverId = await approverFor(ctx, user);
    const body = await jsonBody(c);
    const response = body.response;
    if (!isRecord(response) || typeof response.id !== 'string') {
      throw new AppError(400, 'response_required', 'The passkey response is required.');
    }
    const requestId = await finishCeremony(ctx.db, {
      userId: user.id,
      requestId: body.requestId,
      kind: 'register',
      target: approverId,
      now: ctx.now(),
    });
    const levee = await ctx.platform.levee();
    await levee.post(
      `/v1/approvers/${encodeURIComponent(approverId)}/passkeys`,
      { request_id: requestId, response },
      user.externalRef,
    );
    await ctx.db
      .insert(passkeys)
      .values({ id: newId('pk'), userId: user.id, credentialId: response.id, label: 'Acme Pay passkey' })
      .onConflictDoNothing();
    return c.json({ enrolled: true }, 201);
  });

  return app;
}

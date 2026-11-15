import { desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { agentForUser, agentView, listAgents } from '../agents/service';
import { openApprovalsForUser } from '../approvals/store';
import type { AppContext } from '../context';
import { mandates, purchases } from '../db/schema';
import { jsonBody, requireSession, type AppEnv } from '../http/middleware';
import { listInbox, markRead } from '../inbox/service';
import { AppError } from '../lib/errors';
import { freshenBudgets, liveVersion, loadMandate, mandateForUser, versionStatusLabel } from '../mandates/store';
import { pauseMandate, revokeMandate } from '../mandates/service';
import { purchaseReasons } from '../purchases/service';

/** The signed-in person's overview and the controls only they have: pause, revoke, evidence. */
export function dashboardRoutes(ctx: AppContext) {
  const app = new Hono<AppEnv>();
  app.use('*', requireSession(ctx));

  app.get('/dashboard', async (c) => {
    const { user } = c.get('session');
    const owned = await ctx.db
      .select()
      .from(mandates)
      .where(eq(mandates.userId, user.id))
      .orderBy(desc(mandates.createdAt));
    await freshenBudgets(ctx, user, owned);
    const mandateViews = [];
    for (const { id } of owned) {
      const found = await loadMandate(ctx.db, id);
      if (found === null) continue;
      const { mandate, versions } = found;
      const live = liveVersion(versions);
      mandateViews.push({
        id: mandate.id,
        agentId: mandate.agentId,
        purpose: mandate.terms.purpose,
        status: live === null ? 'pending' : versionStatusLabel(live.status),
        pendingAction: live?.pendingAction ?? null,
        currency: mandate.terms.currency,
        totalMinor: mandate.budget?.totalMinor ?? mandate.terms.totalMinor,
        spentMinor: mandate.budget?.spentMinor ?? 0,
        remainingMinor: mandate.budget?.remainingMinor ?? mandate.terms.totalMinor,
        validUntil: mandate.terms.validUntil,
        categories: mandate.terms.categories,
        cardLast4: mandate.cardLast4,
        freezeStatus: mandate.freezeStatus,
      });
    }
    const activity = await ctx.db
      .select()
      .from(purchases)
      .where(eq(purchases.userId, user.id))
      .orderBy(desc(purchases.createdAt))
      .limit(30);
    return c.json({
      agents: (await listAgents(ctx, user.id)).map(agentView),
      mandates: mandateViews,
      approvals: (await openApprovalsForUser(ctx, user.id)).map(({ approval, url }) => ({
        id: approval.id,
        kind: approval.kind,
        title: approval.shortTitle,
        url,
        expiresAt: approval.expiresAt.toISOString(),
      })),
      purchases: activity.map((purchase) => ({
        id: purchase.id,
        agentId: purchase.agentId,
        merchantName: purchase.merchantName,
        item: purchase.item,
        amountMinor: purchase.amountMinor,
        currency: purchase.currency,
        outcome: purchase.outcome,
        reasons: purchaseReasons(purchase),
        decisionLatencyMs: purchase.decisionLatencyMs,
        createdAt: purchase.createdAt.toISOString(),
      })),
      inbox: (await listInbox(ctx.db, user.id)).map((item) => ({
        id: item.id,
        title: item.title,
        body: item.body,
        read: item.read,
        createdAt: item.createdAt.toISOString(),
      })),
    });
  });

  app.post('/mandates/:id/pause', async (c) => {
    const { user } = c.get('session');
    const { mandate } = await mandateForUser(ctx.db, user, c.req.param('id'));
    await pauseMandate(ctx, user, await agentForUser(ctx, user, mandate.agentId), mandate.id);
    return c.json({ status: 'pause_requested' });
  });

  app.post('/mandates/:id/revoke', async (c) => {
    const { user } = c.get('session');
    if ((await jsonBody(c)).confirm !== true) {
      throw new AppError(
        400,
        'confirmation_required',
        'Confirm that you want to revoke this mandate and freeze its card.',
      );
    }
    await revokeMandate(ctx, user, c.req.param('id'));
    return c.json({ status: 'revoke_requested' });
  });

  app.get('/mandates/:id/evidence', async (c) => {
    const { user } = c.get('session');
    const { mandate } = await mandateForUser(ctx.db, user, c.req.param('id'));
    const levee = await ctx.platform.levee();
    const pack = await levee.get<unknown>(
      `/v1/mandates/${encodeURIComponent(mandate.id)}/evidence.json`,
      user.externalRef,
    );
    c.header('content-disposition', `attachment; filename="evidence-${mandate.id}.json"`);
    return c.json(pack);
  });

  app.post('/inbox/read', async (c) => {
    const { user } = c.get('session');
    const { ids } = await jsonBody(c);
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
      throw new AppError(400, 'invalid_request', 'ids must be a list of inbox item ids.');
    }
    await markRead(ctx.db, user.id, ids);
    return c.json({ read: ids.length });
  });

  return app;
}

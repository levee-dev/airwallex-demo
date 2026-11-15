import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { authenticateAgent, type Agent } from '../agents/service';
import { openApprovalsForUser } from '../approvals/store';
import type { User } from '../auth/sessions';
import type { AppContext } from '../context';
import { mandatesForAgent, requestMandate, requestStatus } from '../mandates/service';
import { purchase, purchaseStatus } from '../purchases/service';
import { handleMcpRequest, type McpCallbacks } from './server';

function callbacksFor(ctx: AppContext, user: User, agent: Agent): McpCallbacks {
  return {
    requestMandate: (input) => requestMandate(ctx, user, agent, input),
    requestStatus: (requestId) => requestStatus(ctx, user, agent, requestId),
    listMandates: async () => ({
      mandates: await mandatesForAgent(ctx, agent),
      approvals: (await openApprovalsForUser(ctx, user.id))
        .filter(({ approval }) => approval.agentId === agent.id)
        .map(({ approval, url }) => ({
          kind: approval.kind,
          summary: approval.shortTitle,
          approval_url: url,
          expires_at: approval.expiresAt.toISOString(),
        })),
    }),
    purchase: (input) => purchase(ctx, user, agent, input),
    purchaseStatus: (purchaseId) => purchaseStatus(ctx, user, agent, purchaseId),
  };
}

/** `/mcp`: Streamable HTTP for agents, authenticated by the agent's bearer token. */
export function mcpRoutes(ctx: AppContext) {
  const app = new Hono();
  app.use('*', bodyLimit({ maxSize: 64 * 1024 }));
  app.all('/', async (c) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    const principal = token.length === 0 ? null : await authenticateAgent(ctx, token);
    if (principal === null) {
      return c.json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }, 401, {
        'www-authenticate': 'Bearer realm="acme-pay"',
      });
    }
    return handleMcpRequest(c.req.raw, callbacksFor(ctx, principal.user, principal.agent), ctx.publicUrl);
  });
  return app;
}

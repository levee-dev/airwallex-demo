import { Hono } from 'hono';
import type { AppContext } from '../context';
import { jsonBody, requireSession, requiredText, type AppEnv } from '../http/middleware';
import { AppError } from '../lib/errors';
import {
  AGENT_CLIENTS,
  agentForUser,
  agentView,
  createAgent,
  listAgents,
  rotateAgentToken,
  type AgentClient,
} from './service';

function isAgentClient(value: unknown): value is AgentClient {
  return typeof value === 'string' && (AGENT_CLIENTS as readonly string[]).includes(value);
}

export function agentRoutes(ctx: AppContext) {
  const app = new Hono<AppEnv>();
  app.use('*', requireSession(ctx));
  const mcpUrl = `${ctx.publicUrl}/mcp`;

  app.get('/', async (c) => {
    const { user } = c.get('session');
    return c.json({ mcpUrl, agents: (await listAgents(ctx, user.id)).map(agentView) });
  });

  app.post('/', async (c) => {
    const { user } = c.get('session');
    const body = await jsonBody(c);
    const name = requiredText(body, 'name', 60);
    if (!isAgentClient(body.client))
      throw new AppError(400, 'invalid_request', `client must be one of ${AGENT_CLIENTS.join(', ')}.`);
    const { agent, token } = await rotateAgentToken(ctx, await createAgent(ctx, user, name, body.client));
    return c.json({ agent: agentView(agent), token, mcpUrl }, 201);
  });

  app.post('/:id/token', async (c) => {
    const { user } = c.get('session');
    const agent = await agentForUser(ctx, user, c.req.param('id'));
    const rotated = await rotateAgentToken(ctx, agent);
    return c.json({ agent: agentView(rotated.agent), token: rotated.token, mcpUrl });
  });

  return app;
}

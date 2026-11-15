import { and, asc, eq } from 'drizzle-orm';
import { requireApprover } from '../accounts/provisioning';
import type { User } from '../auth/sessions';
import type { AppContext } from '../context';
import { agents, users } from '../db/schema';
import { encryptSecret, last4, newId, randomToken, sha256Hex } from '../lib/crypto';
import { AppError } from '../lib/errors';
import { generateAgentKey } from '../levee/agent-signing';

export type Agent = typeof agents.$inferSelect;

export const AGENT_CLIENTS = ['claude_desktop', 'cursor', 'claude_code', 'codex', 'other'] as const;
export type AgentClient = (typeof AGENT_CLIENTS)[number];

const TOKEN_PREFIX = 'acme_agent_';

export function agentView(agent: Agent) {
  return {
    id: agent.id,
    name: agent.name,
    client: agent.client,
    tokenLast4: agent.tokenLast4,
    lastCallAt: agent.lastCallAt?.toISOString() ?? null,
    createdAt: agent.createdAt.toISOString(),
  };
}

export async function listAgents(ctx: AppContext, userId: string): Promise<Agent[]> {
  return ctx.db.select().from(agents).where(eq(agents.userId, userId)).orderBy(asc(agents.createdAt));
}

export async function agentForUser(ctx: AppContext, user: User, agentId: string): Promise<Agent> {
  const [agent] = await ctx.db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.userId, user.id)));
  if (agent === undefined) throw new AppError(404, 'not_found', 'Agent not found.');
  return agent;
}

/**
 * Registers a new agent with Levee under the user's approver. Acme holds the agent's Ed25519
 * signing key (encrypted) and signs its purchase declarations; Levee holds only the public key.
 */
export async function createAgent(ctx: AppContext, user: User, name: string, client: AgentClient): Promise<Agent> {
  const approverId = requireApprover(user);
  const key = generateAgentKey();
  const levee = await ctx.platform.levee();
  const created = await levee.post<{ id: string }>(
    '/v1/agents',
    {
      display_name: name,
      owner: { approver_id: approverId },
      framework: 'acme-pay',
      public_key_jwk: key.publicKeyJwk,
    },
    user.externalRef,
  );
  const [agent] = await ctx.db
    .insert(agents)
    .values({
      id: newId('agt'),
      userId: user.id,
      leveeAgentId: created.id,
      name,
      client,
      signingKey: encryptSecret(key.privateKeyPkcs8, ctx.encryptionKey),
    })
    .returning();
  if (agent === undefined) throw new AppError(500, 'internal', 'The agent could not be saved.');
  return agent;
}

/** Issues a new MCP bearer token, invalidating the previous one. The raw token is returned once. */
export async function rotateAgentToken(ctx: AppContext, agent: Agent): Promise<{ agent: Agent; token: string }> {
  const token = randomToken(TOKEN_PREFIX, 32);
  const [updated] = await ctx.db
    .update(agents)
    .set({ tokenHash: sha256Hex(token), tokenLast4: last4(token) })
    .where(eq(agents.id, agent.id))
    .returning();
  return { agent: updated ?? agent, token };
}

/** The agent and its owner for a bearer token, or null. Records the call for the dashboard. */
export async function authenticateAgent(ctx: AppContext, token: string): Promise<{ agent: Agent; user: User } | null> {
  if (!token.startsWith(TOKEN_PREFIX) || token.length > 200) return null;
  const [row] = await ctx.db
    .select({ agent: agents, user: users })
    .from(agents)
    .innerJoin(users, eq(users.id, agents.userId))
    .where(eq(agents.tokenHash, sha256Hex(token)));
  if (row === undefined) return null;
  const lastCallAt = ctx.now();
  await ctx.db.update(agents).set({ lastCallAt }).where(eq(agents.id, row.agent.id));
  return { agent: { ...row.agent, lastCallAt }, user: row.user };
}

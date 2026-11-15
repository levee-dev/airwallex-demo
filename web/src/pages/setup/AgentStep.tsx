import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Check, EyeOff, KeyRound, Radio } from 'lucide-react';
import { CardAccountPill } from '../../components/CardAccountPill';
import { BackButton, BackToDashboard, StepShell } from '../../components/SetupLayout';
import { BusyIcon, CopyButton, InlineError } from '../../components/ui';
import { api } from '../../lib/api';
import { CLIENTS, mcpConfig } from '../../lib/mcp-config';
import { setupComplete } from '../../lib/setup';
import { useAction } from '../../lib/use-action';
import type { Agent, AgentList, AgentToken, User } from '../../lib/types';

type Client = (typeof CLIENTS)[number]['value'];

const POLL_MS = 5_000;
const PLACEHOLDER = '<token>';

function mask(token: string): string {
  return token.length > 13 ? `${token.slice(0, 10)}${'•'.repeat(9)}${token.slice(-3)}` : token;
}

/** The newest agent this person connected through a client: its token is the one to rotate. */
function agentFor(agents: readonly Agent[], client: Client): Agent | undefined {
  return agents.findLast((agent) => agent.client === client);
}

function ClientTabs({ client, onChange }: { client: Client; onChange: (client: Client) => void }) {
  return (
    <div className="inline-flex flex-wrap rounded-xl bg-canvas p-1 border border-line/60" role="tablist">
      {CLIENTS.map(({ value, label }) => (
        <button
          key={value}
          type="button"
          role="tab"
          aria-selected={client === value}
          onClick={() => {
            onChange(value);
          }}
          className={`rounded-lg px-4 sm:px-6 h-11 text-[15px] sm:text-[16px] font-semibold ${client === value ? 'bg-white border border-line text-ink shadow-card' : 'text-ink-2'}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function useAgents() {
  const [list, setList] = useState<AgentList | null>(null);
  const reload = useCallback(
    () =>
      api<AgentList>('/api/agents').then(setList, () => {
        /* The next poll retries; actions report their own errors. */
      }),
    [],
  );
  useEffect(() => {
    void reload();
  }, [reload]);
  return { list, reload };
}

/** Issues an agent token, shows its MCP config once, and waits for the agent's first tool call. */
export function AgentStep({ user, onUser }: { user: User; onUser: (user: User) => void }) {
  const navigate = useNavigate();
  const { list, reload } = useAgents();
  const { busy, error, run } = useAction();
  const [client, setClient] = useState<Client>('claude_desktop');
  const [issued, setIssued] = useState<Partial<Record<Client, AgentToken>>>({});

  const label = CLIENTS.find((entry) => entry.value === client)?.label ?? 'Agent';
  const existing = list === null ? undefined : agentFor(list.agents, client);
  const token = issued[client];
  const connected = existing?.lastCallAt != null;
  const mcpUrl = token?.mcpUrl ?? list?.mcpUrl ?? '';
  const complete = setupComplete(user);

  useEffect(() => {
    if (token === undefined || connected) return undefined;
    const id = window.setInterval(() => void reload(), POLL_MS);
    return () => {
      window.clearInterval(id);
    };
  }, [token, connected, reload]);

  const generate = () =>
    run('token', async () => {
      const next =
        existing === undefined
          ? await api<AgentToken>('/api/agents', { body: { name: label, client } })
          : await api<AgentToken>(`/api/agents/${encodeURIComponent(existing.id)}/token`, { body: {} });
      setIssued((current) => ({ ...current, [client]: next }));
      await reload();
    });

  const shown = mcpConfig(client, mcpUrl, token === undefined ? PLACEHOLDER : mask(token.token));

  return (
    <StepShell
      step="agent"
      user={user}
      title="Connect your AI agent"
      intro="Paste one config. Your agent can ask for a spending mandate and buy within it. It can never approve its own mandate; that needs your passkey."
      status={<CardAccountPill user={user} onUser={onUser} />}
      footer={
        <>
          {complete ? <BackToDashboard /> : <BackButton to="/setup/phone" />}
          <div className="flex flex-wrap items-center gap-4 ml-auto">
            <span className="text-[15px] text-ink-2 max-w-[460px]" id="finish-reason">
              {!complete
                ? 'To finish: add your passkey.'
                : connected
                  ? `${label} made its first tool call`
                  : 'Turns green when the first tool call lands'}
            </span>
            <button
              type="button"
              className={`btn-primary px-7 ${connected ? '' : 'opacity-90'}`}
              disabled={!complete}
              aria-describedby="finish-reason"
              onClick={() => void navigate('/dashboard')}
            >
              <Check className="h-5 w-5" /> Finish setup
            </button>
          </div>
        </>
      }
    >
      <ClientTabs client={client} onChange={setClient} />

      <div className="mt-7 rounded-2xl bg-dark p-5 sm:p-7">
        <div className="flex items-center justify-between">
          <span className="text-[14px] sm:text-[15px] text-white/70">
            {client === 'claude_code'
              ? 'Paste in your terminal'
              : client === 'codex'
                ? 'Add to ~/.codex/config.toml'
                : `Add to your ${label} MCP config`}
          </span>
          {token !== undefined && <CopyButton value={mcpConfig(client, mcpUrl, token.token)} tone="dark" />}
        </div>
        <pre className="mt-4 font-mono text-[13px] sm:text-[15px] leading-7 text-mint whitespace-pre overflow-x-auto">
          {shown}
        </pre>
        {token === undefined && (
          <button
            type="button"
            className="mt-4 btn h-11 bg-mint text-dark hover:bg-white"
            disabled={busy !== '' || !complete}
            onClick={() => void generate()}
          >
            <BusyIcon busy={busy === 'token'} icon={KeyRound} />
            {existing === undefined ? `Generate ${label} token` : `Rotate ${label} token`}
          </button>
        )}
      </div>
      <p className="mt-5 flex items-center gap-3 text-[15px] sm:text-[16px] text-ink-2">
        <EyeOff className="h-5 w-5 shrink-0" /> The token is shown once and stored only as a hash. To rotate it, come
        back to this step and generate a new one; the old token stops working.
      </p>
      <InlineError>{error}</InlineError>
      <div className="my-7 h-px bg-line" />
      <div className="flex items-center gap-4">
        <span
          className={`h-14 w-14 shrink-0 rounded-full grid place-items-center ${connected ? 'bg-accent text-white' : 'bg-accent-soft text-accent'}`}
        >
          {connected ? <Check className="h-6 w-6" /> : <Radio className="h-6 w-6" />}
        </span>
        <div>
          <p className="text-[18px] sm:text-[20px] font-semibold">
            {connected ? `${label} is connected` : 'Waiting for your agent…'}
          </p>
          <p className="text-[15px] sm:text-[17px] text-ink-2">
            Then ask it: &quot;Get a $200 budget for books and buy me a novel&quot;
          </p>
        </div>
      </div>
    </StepShell>
  );
}

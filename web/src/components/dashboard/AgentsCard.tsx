import { Link } from 'react-router';
import { Plus } from 'lucide-react';
import { ago } from '../../lib/format';
import { clientLabel } from '../../lib/mcp-config';
import type { Agent } from '../../lib/types';

export function AgentsCard({ agents }: { agents: readonly Agent[] }) {
  return (
    <section className="card p-5 sm:p-9">
      <h2 className="text-[20px] sm:text-[23px] font-semibold">Agents</h2>
      {agents.length === 0 && <p className="mt-4 text-ink-2">No agent connected yet.</p>}
      <ul className="mt-5 space-y-5">
        {agents.map((agent) => (
          <li key={agent.id} className="flex items-start gap-4">
            <span
              className={`mt-2 h-2.5 w-2.5 rounded-full ${agent.lastCallAt !== null ? 'bg-accent' : 'bg-ink-3/50'}`}
            />
            <span>
              <span className="block text-[17px] sm:text-[19px] font-semibold">{agent.name}</span>
              <span className="block text-[15px] sm:text-[16px] text-ink-2">
                {clientLabel(agent.client)} ·{' '}
                {agent.lastCallAt !== null ? `Last call ${ago(agent.lastCallAt)}` : 'Not connected yet'}
                {agent.tokenLast4 !== null && ` · token …${agent.tokenLast4}`}
              </span>
            </span>
          </li>
        ))}
      </ul>
      <Link to="/setup/agent" className="btn-secondary mt-6">
        <Plus className="h-5 w-5" /> Connect another agent
      </Link>
    </section>
  );
}

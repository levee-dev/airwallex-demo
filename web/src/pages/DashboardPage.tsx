import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { AlertCircle, ArrowRight, BellRing, CheckCircle2 } from 'lucide-react';
import { CardAccountPill } from '../components/CardAccountPill';
import { Activity } from '../components/dashboard/Activity';
import { AgentsCard } from '../components/dashboard/AgentsCard';
import { AttentionBanner } from '../components/dashboard/AttentionBanner';
import { Inbox } from '../components/dashboard/Inbox';
import { MandateCard } from '../components/dashboard/MandateCard';
import { NAV, Sidebar, type Tab } from '../components/dashboard/Sidebar';
import { InlineError, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { setupComplete } from '../lib/setup';
import type { Dashboard, User } from '../lib/types';

const POLL_MS = 5_000;

function ConnectionPill({ user, data }: { user: User; data: Dashboard }) {
  const pill = 'pill text-[14px] sm:text-[16px] px-4 py-2';
  if (setupComplete(user) && data.agents.some((agent) => agent.lastCallAt !== null)) {
    return (
      <span className={`${pill} bg-accent-soft text-accent`}>
        <CheckCircle2 className="h-4 w-4" /> Account, passkey and agent connected
      </span>
    );
  }
  return (
    <Link to="/setup" className={`${pill} bg-amber-soft text-amber-ink`}>
      <AlertCircle className="h-4 w-4" /> Finish setup
    </Link>
  );
}

function useDashboard() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  // State is only set in the promise callbacks, so the effect subscribes rather than setting state synchronously.
  const load = useCallback(
    () =>
      api<Dashboard>('/api/dashboard').then(
        (next) => {
          setData(next);
          setError(null);
        },
        (failure: unknown) => {
          setError(errorMessage(failure));
        },
      ),
    [],
  );
  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), POLL_MS);
    return () => {
      window.clearInterval(id);
    };
  }, [load]);
  return { data, error, load };
}

/** Shown until a phone gets approval notifications; the phone step was skippable. */
function PhoneNudge() {
  return (
    <div className="rounded-2xl border border-line bg-white px-5 sm:px-8 py-5 flex flex-wrap items-center gap-4">
      <BellRing className="h-6 w-6 text-accent" />
      <p className="flex-1 min-w-[200px] text-[16px] sm:text-[18px]">
        <span className="font-semibold">Enable phone notifications</span>
        <span className="text-ink-2"> to get approval requests on your phone.</span>
      </p>
      <Link to="/setup/phone" className="btn-secondary px-6">
        <ArrowRight className="h-5 w-5" /> Set up
      </Link>
    </div>
  );
}

interface DashboardProps {
  readonly user: User;
  readonly onUser: (user: User) => void;
  readonly onSignOut: () => void;
}

export function DashboardPage({ user, onUser, onSignOut }: DashboardProps) {
  const [tab, setTab] = useState<Tab>('overview');
  const { data, error, load } = useDashboard();
  const show = (section: Tab) => tab === 'overview' || tab === section;
  const title = NAV.find((entry) => entry.id === tab)?.label ?? 'Overview';

  return (
    <div className="min-h-screen lg:flex">
      <Sidebar tab={tab} onTab={setTab} name={user.name} onSignOut={onSignOut} />
      <main className="flex-1 px-4 py-6 sm:px-10 lg:px-[66px] lg:py-14 min-w-0">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-[32px] sm:text-[44px] font-bold tracking-tight">{title}</h1>
          <div className="flex flex-wrap items-center gap-3">
            <CardAccountPill user={user} onUser={onUser} />
            {data !== null && <ConnectionPill user={user} data={data} />}
          </div>
        </div>
        {error !== null && (
          <div className="mt-8">
            <InlineError>{error}</InlineError>
          </div>
        )}
        {data === null ? (
          error === null && (
            <div className="mt-16 grid place-items-center text-ink-2">
              <Spinner className="h-6 w-6" />
            </div>
          )
        ) : (
          <div className="mt-8 space-y-8">
            {tab === 'overview' &&
              data.approvals.map((approval) => <AttentionBanner key={approval.id} approval={approval} />)}
            {tab === 'overview' && !user.phoneNotifications && <PhoneNudge />}
            <div className={`grid gap-8 ${tab === 'overview' ? 'xl:grid-cols-[1fr_550px]' : ''}`}>
              {show('mandates') && (
                <div className="space-y-8">
                  {data.mandates.length === 0 ? (
                    <section className="card p-8 text-ink-2">
                      No mandate yet. Ask your agent to buy something and approve the link it shows you.
                    </section>
                  ) : (
                    data.mandates.map((mandate) => (
                      <MandateCard
                        key={mandate.id}
                        mandate={mandate}
                        agentName={data.agents.find((agent) => agent.id === mandate.agentId)?.name ?? 'Agent'}
                        onChanged={load}
                      />
                    ))
                  )}
                </div>
              )}
              {show('agents') && <AgentsCard agents={data.agents} />}
            </div>
            {show('purchases') && <Activity purchases={data.purchases} />}
            {tab === 'overview' && <Inbox items={data.inbox} />}
          </div>
        )}
      </main>
    </div>
  );
}

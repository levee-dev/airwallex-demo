import { Link } from 'react-router';
import { Ban, CheckCircle2, Link2Off, TimerOff, XCircle, type LucideIcon } from 'lucide-react';
import { Logo } from '../ui';

export type ResultKind =
  'approved' | 'allowed_once' | 'allowed_from_now_on' | 'declined' | 'denied' | 'used' | 'expired' | 'invalid';

interface ResultCopy {
  readonly icon: LucideIcon;
  readonly ring: string;
  readonly title: string;
  readonly body: (agent: string) => string;
  readonly cta: string | null;
}

const OK = 'bg-accent-soft text-accent';
const QUIET = 'bg-canvas text-ink-2 border border-line';

const RESULTS: Record<ResultKind, ResultCopy> = {
  approved: {
    icon: CheckCircle2,
    ring: OK,
    title: 'Approved. Back to your agent.',
    body: (agent) => `${agent} picks this up in a few seconds. You can close this tab.`,
    cta: 'Open dashboard',
  },
  allowed_once: {
    icon: CheckCircle2,
    ring: OK,
    title: 'Allowed once. Back to your agent.',
    body: (agent) => `${agent} retries the purchase in a few seconds. You can close this tab.`,
    cta: 'Open dashboard',
  },
  allowed_from_now_on: {
    icon: CheckCircle2,
    ring: OK,
    title: 'Allowed from now on.',
    body: (agent) => `${agent} retries the purchase now. Future purchases here skip this check, within budget.`,
    cta: 'Open dashboard',
  },
  declined: {
    icon: XCircle,
    ring: QUIET,
    title: 'Declined. Nothing was approved.',
    body: (agent) => `${agent} is told no. You can close this tab.`,
    cta: 'Open dashboard',
  },
  denied: {
    icon: Ban,
    ring: QUIET,
    title: 'Denied. Nothing was charged.',
    body: (agent) => `${agent} is told no and given the reason.`,
    cta: 'Open dashboard',
  },
  used: {
    icon: Link2Off,
    ring: 'bg-amber-soft text-amber-ink',
    title: 'This link was already used',
    body: () => "Each approval link works once. If you didn't use it, revoke the mandate now.",
    cta: 'Review in dashboard',
  },
  expired: {
    icon: TimerOff,
    ring: 'bg-rose-soft text-rose-ink',
    title: 'This link expired',
    body: () => 'Ask your agent to request approval again. It will show you a fresh link.',
    cta: null,
  },
  invalid: {
    icon: Link2Off,
    ring: 'bg-rose-soft text-rose-ink',
    title: "This link doesn't work",
    body: () => 'Check you copied the whole link, or ask your agent for a fresh one.',
    cta: null,
  },
};

export function isResultKind(value: string): value is ResultKind {
  return value in RESULTS;
}

export function Result({ kind, agent = 'Your agent' }: { kind: ResultKind; agent?: string }) {
  const result = RESULTS[kind];
  const Icon = result.icon;
  return (
    <div className="min-h-[100dvh] flex flex-col px-6 pt-8 pb-8 sm:px-10 max-w-[560px] mx-auto">
      <Logo size="sm" />
      <div className="flex-1 flex flex-col items-center justify-center text-center py-12">
        <div className={`h-28 w-28 rounded-full grid place-items-center ${result.ring}`}>
          <Icon className="h-11 w-11" strokeWidth={2} />
        </div>
        <h1 className="mt-8 text-[28px] sm:text-[32px] leading-tight font-bold tracking-tight text-balance">
          {result.title}
        </h1>
        <p className="mt-4 text-[17px] sm:text-[18px] leading-relaxed text-ink-2 text-balance">{result.body(agent)}</p>
      </div>
      {result.cta !== null && (
        <Link to="/dashboard" className="btn-secondary h-[60px] w-full text-[17px]">
          {result.cta}
        </Link>
      )}
    </div>
  );
}

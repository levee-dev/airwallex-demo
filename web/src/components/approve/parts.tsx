import { useEffect } from 'react';
import { Timer } from 'lucide-react';
import { useCountdown } from '../../lib/use-countdown';
import { Logo } from '../ui';

export type Row = readonly [label: string, value: string];

export function Rows({ rows, compact = false }: { rows: readonly Row[]; compact?: boolean }) {
  const text = compact ? 'text-[16px]' : 'text-[16px] sm:text-[18px]';
  return (
    <div className={`card ${compact ? 'px-5 py-1' : 'px-6 sm:px-9 py-2'}`}>
      {rows.map(([label, value], i) => (
        <div
          key={label}
          className={`flex items-center justify-between gap-4 ${compact ? 'py-3.5' : 'py-4'} ${i > 0 ? 'border-t border-line' : ''}`}
        >
          <span className={`text-ink-2 ${text}`}>{label}</span>
          <span className={`font-semibold text-right ${text}`}>{value}</span>
        </div>
      ))}
    </div>
  );
}

export function ExpiryPill({
  expiresAt,
  compact = false,
  onExpire,
}: {
  expiresAt: string;
  compact?: boolean;
  onExpire: () => void;
}) {
  const { text, expired } = useCountdown(expiresAt);
  useEffect(() => {
    if (expired) onExpire();
  }, [expired, onExpire]);
  return (
    <span className="pill bg-amber-soft text-amber-ink text-[14px] sm:text-[15px] px-4 py-2">
      <Timer className="h-4 w-4" />
      {compact ? text : `Single-use link · expires in ${text}`}
    </span>
  );
}

/** Logo and expiry pill, sized for phone and desktop. */
export function ApprovalHeader({ expiresAt, onExpire }: { expiresAt: string; onExpire: () => void }) {
  return (
    <header className="flex items-center justify-between">
      <span className="md:hidden">
        <Logo size="sm" />
      </span>
      <span className="hidden md:block">
        <Logo />
      </span>
      <span className="md:hidden">
        <ExpiryPill expiresAt={expiresAt} compact onExpire={onExpire} />
      </span>
      <span className="hidden md:block">
        <ExpiryPill expiresAt={expiresAt} onExpire={onExpire} />
      </span>
    </header>
  );
}

export function Notes({ notes }: { notes: readonly string[] }) {
  if (notes.length === 0) return null;
  return (
    <ul className="mt-6 space-y-3">
      {notes.map((text) => (
        <li key={text} className="rounded-xl bg-amber-soft px-4 py-3 text-[15px] sm:text-[16px] text-amber-ink">
          {text}
        </li>
      ))}
    </ul>
  );
}

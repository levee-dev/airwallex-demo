import { useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { Check, Copy, Loader2, type LucideIcon } from 'lucide-react';

export function Logo({
  dark = false,
  size = 'md',
  soft = false,
}: {
  dark?: boolean;
  size?: 'sm' | 'md';
  soft?: boolean;
}) {
  const box = size === 'sm' ? 'h-9 w-9 text-base rounded-lg' : 'h-11 w-11 text-lg rounded-xl';
  const tile = soft ? 'bg-mint text-dark' : 'bg-accent text-white';
  return (
    <div className="flex items-center gap-3">
      <div className={`${box} ${tile} grid place-items-center font-bold`}>A</div>
      <span
        className={`font-semibold tracking-tight ${size === 'sm' ? 'text-lg' : 'text-[22px]'} ${dark ? 'text-white' : 'text-ink'}`}
      >
        Acme Pay
      </span>
    </div>
  );
}

export function Spinner({ className = 'h-4 w-4' }: { className?: string }) {
  return <Loader2 className={`${className} animate-spin`} aria-hidden="true" />;
}

/** A spinner while `busy`, otherwise the action's icon. */
export function BusyIcon({
  busy,
  icon: Icon,
  className = 'h-5 w-5',
}: {
  busy: boolean;
  icon: LucideIcon;
  className?: string;
}) {
  return busy ? <Spinner className="h-5 w-5" /> : <Icon className={className} />;
}

export function SpinnerPage() {
  return (
    <div className="min-h-screen grid place-items-center text-ink-2">
      <Spinner className="h-6 w-6" />
    </div>
  );
}

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  readonly label: string;
  readonly icon: LucideIcon;
  readonly hint?: string | undefined;
}

export function Field({ label, icon: Icon, hint, ...input }: FieldProps) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <span className="input-wrap">
        <Icon className="h-5 w-5 text-ink-2 shrink-0" aria-hidden="true" />
        <input {...input} />
      </span>
      {hint !== undefined && <span className="hint block">{hint}</span>}
    </label>
  );
}

async function writeClipboard(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const area = document.createElement('textarea');
    area.value = value;
    document.body.appendChild(area);
    area.select();
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- fallback where the async clipboard is blocked
    document.execCommand('copy');
    area.remove();
  }
}

export function CopyButton({ value, tone = 'light' }: { value: string; tone?: 'light' | 'dark' }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await writeClipboard(value);
    setCopied(true);
    window.setTimeout(() => {
      setCopied(false);
    }, 1600);
  };
  const color = tone === 'dark' ? 'text-mint hover:text-white' : 'text-accent hover:text-accent-hover';
  return (
    <button
      type="button"
      onClick={() => void copy()}
      className={`inline-flex items-center gap-1.5 text-[14px] font-semibold ${color}`}
    >
      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

export function InlineError({ children }: { children: string | null }) {
  if (children === null || children === '') return null;
  return (
    <p className="mt-3 text-[14px] text-rose-ink bg-rose-soft rounded-lg px-3 py-2" role="alert">
      {children}
    </p>
  );
}

const PILL_TONES = {
  ok: 'bg-accent-soft text-accent',
  wait: 'bg-amber-soft text-amber-ink',
  bad: 'bg-rose-soft text-rose-ink',
  neutral: 'bg-canvas text-ink-2',
} as const;

export type PillTone = keyof typeof PILL_TONES;

export function StatusPill({
  tone,
  icon: Icon,
  className = '',
  children,
}: {
  tone: PillTone;
  icon?: LucideIcon | undefined;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span className={`pill ${PILL_TONES[tone]} ${className}`} role="status">
      {Icon !== undefined && <Icon className="h-4 w-4" />}
      {children}
    </span>
  );
}

/** Full-page notice for when the server can't be reached: never the sign-in form. */
export function Unavailable({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="min-h-screen px-5 py-8 sm:px-10 max-w-[720px] mx-auto">
      <Logo />
      <h1 className="mt-10 text-[30px] font-bold tracking-tight">Acme Pay</h1>
      <div className="mt-6">
        <InlineError>{message}</InlineError>
      </div>
      <button type="button" className="btn-secondary mt-6" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

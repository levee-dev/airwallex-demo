import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { ArrowLeft, Check } from 'lucide-react';
import { SETUP_STEPS, stepDone, type SetupStepId } from '../lib/setup';
import type { User } from '../lib/types';
import { Logo } from './ui';

function SetupSidebar({ current, user }: { current: SetupStepId; user: User }) {
  const index = SETUP_STEPS.findIndex((step) => step.id === current);
  return (
    <aside className="bg-dark text-white lg:w-[340px] xl:w-[400px] shrink-0 lg:min-h-screen lg:sticky lg:top-0 flex flex-col px-5 py-5 lg:px-8 lg:py-10">
      <Logo dark soft />
      <p className="hidden lg:block mt-12 mb-3 text-[13px] font-semibold tracking-[0.12em] text-white/60">SETUP</p>
      <ol className="hidden lg:flex flex-col gap-2">
        {SETUP_STEPS.map((step, i) => {
          const done = stepDone(step.id, user);
          const active = i === index;
          return (
            <li key={step.id} className={`flex items-center gap-4 rounded-xl px-4 py-3 ${active ? 'bg-dark-2' : ''}`}>
              {done ? (
                <span className="h-10 w-10 rounded-full bg-mint text-dark grid place-items-center">
                  <Check className="h-5 w-5" strokeWidth={2.5} />
                </span>
              ) : (
                <span
                  className={`h-10 w-10 rounded-full border-2 grid place-items-center text-[15px] font-semibold ${active ? 'border-mint text-mint' : 'border-white/30 text-white/70'}`}
                >
                  {i + 1}
                </span>
              )}
              <span>
                <span className={`block text-[17px] font-semibold ${active || done ? 'text-white' : 'text-white/75'}`}>
                  {step.title}
                </span>
                <span className="block text-[14px] text-white/60">{step.sub}</span>
              </span>
            </li>
          );
        })}
      </ol>
      <div className="lg:hidden mt-4 flex gap-1.5" aria-label={`Step ${index + 1} of ${SETUP_STEPS.length}`}>
        {SETUP_STEPS.map((step, i) => (
          <span
            key={step.id}
            className={`h-1.5 flex-1 rounded-full ${stepDone(step.id, user) ? 'bg-mint' : i === index ? 'bg-mint/50' : 'bg-white/20'}`}
          />
        ))}
      </div>
      <p className="hidden lg:block mt-auto pt-10 text-[14px] leading-7 text-white/60">
        Demo merchant powered by Levee
        <br />
        Sandbox only. No real money moves.
      </p>
    </aside>
  );
}

interface StepShellProps {
  readonly step: SetupStepId;
  readonly user: User;
  readonly title: string;
  readonly intro: string;
  readonly footer: ReactNode;
  /** Shown beside the step number, e.g. the card account status. */
  readonly status?: ReactNode;
  readonly children: ReactNode;
}

export function StepShell({ step, user, title, intro, footer, status, children }: StepShellProps) {
  const index = SETUP_STEPS.findIndex((entry) => entry.id === step);
  return (
    <div className="min-h-screen lg:flex">
      <SetupSidebar current={step} user={user} />
      <main className="flex-1 px-5 py-8 sm:px-10 lg:px-16 lg:py-14">
        <div className="max-w-[980px]">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-[13px] font-semibold tracking-[0.14em] text-accent">
              STEP {index + 1} OF {SETUP_STEPS.length}
            </p>
            {status}
          </div>
          <h1 className="mt-2 text-[30px] sm:text-[40px] leading-tight font-bold tracking-tight">{title}</h1>
          <p className="mt-3 text-[16px] sm:text-[18px] leading-relaxed text-ink-2 max-w-[960px]">{intro}</p>
          <div className="card mt-8 p-5 sm:p-10">{children}</div>
          <div className="mt-8 sm:mt-10 flex flex-wrap items-center justify-between gap-4">{footer}</div>
        </div>
      </main>
    </div>
  );
}

export function BackButton({ to }: { to: string }) {
  return (
    <Link to={to} className="btn-secondary px-6">
      <ArrowLeft className="h-5 w-5" /> Back
    </Link>
  );
}

export function BackToDashboard() {
  return (
    <Link to="/dashboard" className="btn-secondary px-6">
      Back to dashboard
    </Link>
  );
}

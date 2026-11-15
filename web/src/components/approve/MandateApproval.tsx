import { Bot, KeyRound, Link2Off, Pause, ScanFace, ShieldCheck, X } from 'lucide-react';
import { dateLong, daysLeft, money, moneyShort, plural } from '../../lib/format';
import { clientLabel } from '../../lib/mcp-config';
import type { ApprovalItem, ApprovalPage } from '../../lib/types';
import { BusyIcon, InlineError, Logo, Spinner } from '../ui';
import { ExpiryPill, Notes, Rows, type Row } from './parts';
import type { ApprovalProps } from './types';

const isApple = () => /iPhone|iPad|iPod/.test(navigator.userAgent);

const toRows = (items: readonly ApprovalItem[]): Row[] => items.map((item) => [item.label, item.value]);

function budgetRows(view: ApprovalPage, compact: boolean): Row[] {
  const { budget } = view;
  const resume = view.kind === 'resume';
  const cur = budget.currency;
  if (compact) {
    return [
      ['Budget', resume ? `${money(budget.remainingMinor, cur)} left` : money(budget.totalMinor, cur)],
      ['Until', dateLong(budget.validUntil)],
      ['Asks again', 'Over your remaining budget'],
    ];
  }
  return [
    [
      'Budget',
      resume
        ? `${money(budget.remainingMinor, cur)} left of ${moneyShort(budget.totalMinor, cur)}`
        : `${money(budget.totalMinor, cur)} total`,
    ],
    ['Valid for', `${plural(daysLeft(budget.validUntil), 'day')} · until ${dateLong(budget.validUntil)}`],
    ['Categories', budget.categories.join(' · ') || 'Any'],
    ['Per purchase', budget.perPurchaseCapMinor === null ? 'No cap' : moneyShort(budget.perPurchaseCapMinor, cur)],
    ['Asks you again', 'Any purchase over your remaining budget'],
  ];
}

/** Levee's preview of the mandate: what the person asked for and what was filled in for them. */
function Preview({ preview }: { preview: NonNullable<ApprovalPage['preview']> }) {
  return (
    <>
      {preview.youSaid.length > 0 && (
        <>
          <h2 className="mt-8 text-[18px] sm:text-[20px] font-semibold">You said</h2>
          <div className="mt-3">
            <Rows rows={toRows(preview.youSaid)} />
          </div>
        </>
      )}
      {preview.weFilledIn.length > 0 && (
        <>
          <h2 className="mt-7 text-[18px] sm:text-[20px] font-semibold">We filled in</h2>
          <div className="mt-3">
            <Rows rows={toRows(preview.weFilledIn)} />
          </div>
        </>
      )}
      <Notes notes={[...preview.warnings, ...preview.notes, ...preview.riskNotes]} />
    </>
  );
}

function Assurances() {
  return (
    <ul className="space-y-3 text-[17px] text-ink-2">
      <li className="flex items-center gap-3">
        <ShieldCheck className="h-5 w-5 text-accent" /> Checked by Levee before every purchase
      </li>
      <li className="flex items-center gap-3">
        <Link2Off className="h-5 w-5 text-accent" /> This link works once, then it&apos;s dead
      </li>
      <li className="flex items-center gap-3">
        <Pause className="h-5 w-5 text-accent" /> Pause or revoke any time from your dashboard
      </li>
    </ul>
  );
}

function Desktop({ view, act, busy, error, onExpire }: ApprovalProps) {
  const resume = view.kind === 'resume';
  return (
    <div className="hidden md:block min-h-screen px-10 lg:px-[110px] py-12">
      <header className="flex items-center justify-between">
        <Logo />
        <ExpiryPill expiresAt={view.expiresAt} onExpire={onExpire} />
      </header>
      <div className="mt-10 grid grid-cols-1 lg:grid-cols-[1fr_612px] gap-12">
        <section>
          <div className="flex items-center gap-4">
            <span className="h-[60px] w-[60px] rounded-full bg-dark text-mint grid place-items-center">
              <Bot className="h-7 w-7" />
            </span>
            <div>
              <p className="text-[19px] font-semibold">{view.agent.name}</p>
              <p className="text-[17px] text-ink-2">Requested from {clientLabel(view.agent.client)}</p>
            </div>
          </div>
          <h1 className="mt-8 text-[40px] xl:text-[52px] leading-[1.1] font-bold tracking-tight">{view.title}</h1>
          {view.intentQuote !== null && <p className="mt-6 text-[20px] text-ink-2">&ldquo;{view.intentQuote}&rdquo;</p>}
          <div className="mt-8">
            <Rows rows={budgetRows(view, false)} />
          </div>
          {view.preview !== null && <Preview preview={view.preview} />}
        </section>
        <section className="card p-10 self-start">
          <div className="h-[86px] w-[86px] rounded-2xl bg-accent-soft text-accent grid place-items-center">
            <KeyRound className="h-9 w-9" />
          </div>
          <h2 className="mt-7 text-[30px] font-bold tracking-tight">Confirm it&apos;s you</h2>
          <p className="mt-4 text-[18px] leading-relaxed text-ink-2">
            Your agent can&apos;t do this step. Only you can, with the passkey for {view.approverHint}
          </p>
          <button
            type="button"
            className="btn-primary w-full h-[72px] mt-7 text-[19px]"
            onClick={() => {
              act('approve');
            }}
            disabled={busy !== null}
          >
            <BusyIcon busy={busy === 'approve'} icon={ScanFace} className="h-6 w-6" />
            {resume ? 'Resume with passkey' : 'Approve with passkey'}
          </button>
          <button
            type="button"
            className="btn-secondary w-full h-[72px] mt-6 text-[19px]"
            onClick={() => {
              act('decline');
            }}
            disabled={busy !== null}
          >
            <BusyIcon busy={busy === 'decline'} icon={X} /> Decline
          </button>
          <InlineError>{error}</InlineError>
          <div className="my-6 h-px bg-line" />
          <Assurances />
        </section>
      </div>
    </div>
  );
}

function Phone({ view, act, busy, error, onExpire }: ApprovalProps) {
  const resume = view.kind === 'resume';
  const chips = [plural(daysLeft(view.budget.validUntil), 'day'), ...view.budget.categories];
  return (
    <div className="md:hidden min-h-[100dvh] flex flex-col px-5 pt-[max(1.75rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <header className="flex items-center justify-between">
        <Logo size="sm" />
        <ExpiryPill expiresAt={view.expiresAt} compact onExpire={onExpire} />
      </header>
      <h1 className="mt-6 text-[28px] leading-[1.2] font-bold tracking-tight">{view.shortTitle}</h1>
      <div className="mt-5 flex flex-wrap gap-2">
        {chips.map((chip) => (
          <span key={chip} className="rounded-xl border border-line bg-white/60 px-3 py-2 text-[15px] font-medium">
            {chip}
          </span>
        ))}
      </div>
      <div className="mt-6">
        <Rows rows={budgetRows(view, true)} compact />
      </div>
      {view.intentQuote !== null && <p className="mt-5 text-[15px] text-ink-2">&ldquo;{view.intentQuote}&rdquo;</p>}
      {view.preview !== null && <Notes notes={[...view.preview.warnings, ...view.preview.riskNotes]} />}
      <div className="flex-1 min-h-8" />
      <p className="text-[15px] text-ink-2">Only you can approve. Your agent can&apos;t use your passkey.</p>
      <button
        type="button"
        className="btn-primary w-full h-[60px] mt-4 text-[17px]"
        onClick={() => {
          act('approve');
        }}
        disabled={busy !== null}
      >
        <BusyIcon busy={busy === 'approve'} icon={ScanFace} />
        {resume ? 'Resume with passkey' : isApple() ? 'Approve with Face ID' : 'Approve with passkey'}
      </button>
      <button
        type="button"
        className="btn-secondary w-full h-[60px] mt-4 text-[17px]"
        onClick={() => {
          act('decline');
        }}
        disabled={busy !== null}
      >
        {busy === 'decline' && <Spinner className="h-5 w-5" />} Decline
      </button>
      <InlineError>{error}</InlineError>
    </div>
  );
}

/** A new mandate or a paused one to resume: desktop and phone layouts. */
export function MandateApproval(props: ApprovalProps) {
  return (
    <>
      <Desktop {...props} />
      <Phone {...props} />
    </>
  );
}

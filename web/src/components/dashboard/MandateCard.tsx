import { AlertCircle, CheckCircle2, CircleX, FileSearch, Snowflake, type LucideIcon } from 'lucide-react';
import { api } from '../../lib/api';
import { daysLeft, moneyShort, plural } from '../../lib/format';
import { useAction } from '../../lib/use-action';
import type { MandateSummary } from '../../lib/types';
import { BusyIcon, InlineError, StatusPill, type PillTone } from '../ui';

function statusOf(mandate: MandateSummary): { tone: PillTone; icon: LucideIcon; text: string } {
  switch (mandate.status) {
    case 'active':
      return { tone: 'ok', icon: CheckCircle2, text: `Active · ${plural(daysLeft(mandate.validUntil), 'day')} left` };
    case 'paused':
      return { tone: 'wait', icon: Snowflake, text: 'Card frozen' };
    case 'pending':
      return { tone: 'wait', icon: AlertCircle, text: 'Waiting for approval' };
    case 'ended':
      return { tone: 'neutral', icon: CircleX, text: 'Ended' };
  }
}

function note(mandate: MandateSummary): string {
  if (mandate.freezeStatus === 'failed')
    return "Airwallex didn't confirm the card freeze. Levee still declines every purchase.";
  switch (mandate.pendingAction) {
    case 'pause':
      return 'Freezing… waiting for Levee to confirm.';
    case 'resume':
      return 'Unfreezing… waiting for Levee to confirm.';
    case 'revoke':
      return 'Revoking… waiting for Levee to confirm.';
    default:
      return mandate.status === 'paused'
        ? 'Frozen: Levee declines every purchase on this card. Unfreeze it with your passkey from the link above.'
        : 'Freeze card makes Levee decline every purchase until you unfreeze it with your passkey.';
  }
}

interface Props {
  readonly mandate: MandateSummary;
  readonly agentName: string;
  readonly onChanged: () => Promise<void>;
}

export function MandateCard({ mandate, agentName, onChanged }: Props) {
  const { busy, error, run } = useAction();
  const status = statusOf(mandate);
  const pct = mandate.totalMinor === 0 ? 0 : Math.min(100, Math.round((mandate.spentMinor / mandate.totalMinor) * 100));
  const live = mandate.status === 'active' || mandate.status === 'paused';
  const settling = mandate.pendingAction !== null;

  const act = (label: string, path: string, body: unknown = {}) =>
    run(label, async () => {
      await api(`/api/mandates/${encodeURIComponent(mandate.id)}/${path}`, { body });
      await onChanged();
    });

  const revoke = () => {
    if (
      window.confirm(
        'Revoke this mandate and freeze its card? Your agent will not be able to spend again until it asks for a new mandate.',
      )
    ) {
      void act('revoke', 'revoke', { confirm: true });
    }
  };

  return (
    <section className="card p-5 sm:p-9">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-[20px] sm:text-[23px] font-semibold">{mandate.purpose}</h2>
          <p className="text-[15px] text-ink-2">
            {agentName}
            {mandate.cardLast4 !== null && ` · card •••• ${mandate.cardLast4}`}
          </p>
        </div>
        <StatusPill tone={status.tone} icon={status.icon} className="text-[14px] sm:text-[16px]">
          {status.text}
        </StatusPill>
      </div>
      <p className="mt-6 text-[32px] sm:text-[44px] font-bold tracking-tight">
        {moneyShort(mandate.spentMinor, mandate.currency)} spent of {moneyShort(mandate.totalMinor, mandate.currency)}
      </p>
      <div
        className="mt-5 h-3 rounded-full bg-canvas overflow-hidden"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-6 flex flex-wrap gap-3">
        <button
          type="button"
          className="btn-secondary"
          disabled={busy !== '' || mandate.status !== 'active' || settling}
          onClick={() => void act('freeze', 'pause')}
        >
          <BusyIcon busy={busy === 'freeze'} icon={Snowflake} /> Freeze card
        </button>
        <button type="button" className="btn-secondary" disabled={busy !== '' || !live} onClick={revoke}>
          <BusyIcon busy={busy === 'revoke'} icon={CircleX} /> Revoke
        </button>
        <a className="btn-secondary" href={`/api/mandates/${encodeURIComponent(mandate.id)}/evidence`} download>
          <FileSearch className="h-5 w-5" /> Evidence
        </a>
      </div>
      {live && <p className="mt-4 text-[14px] sm:text-[15px] text-ink-2">{note(mandate)}</p>}
      <InlineError>{error}</InlineError>
    </section>
  );
}

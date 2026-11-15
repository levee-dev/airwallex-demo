import { useState } from 'react';
import { Ban, Hand, Repeat, ScanFace, type LucideIcon } from 'lucide-react';
import { money, moneyShort } from '../../lib/format';
import type { ApprovalAction, ApprovalPage } from '../../lib/types';
import { BusyIcon, InlineError } from '../ui';
import { ApprovalHeader, Rows, type Row } from './parts';
import type { ApprovalProps } from './types';

type Choice = Extract<ApprovalAction, 'allow-once' | 'allow-from-now-on' | 'deny'>;

interface Option {
  readonly id: Choice;
  readonly icon: LucideIcon;
  readonly title: string;
  readonly body: string;
}

function optionsFor(view: ApprovalPage, amount: string): Option[] {
  const merchant = view.merchant?.name ?? 'this shop';
  const all: Option[] = [
    view.firstPurchase !== null
      ? {
          id: 'allow-once',
          icon: ScanFace,
          title: 'Approve this payment',
          body: `This ${amount} only. It does not trust the shop for future payments. Needs your passkey.`,
        }
      : { id: 'allow-once', icon: ScanFace, title: 'Allow once', body: `This ${amount} only. Needs your passkey.` },
    {
      id: 'allow-from-now-on',
      icon: Repeat,
      title: `Allow ${merchant} from now on`,
      body: 'Future purchases here skip this check, within budget. Needs your passkey.',
    },
    { id: 'deny', icon: Ban, title: 'Deny', body: 'The agent is told no and given the reason.' },
  ];
  return all.filter((option) => view.allowedActions.includes(option.id));
}

function heldRows(view: ApprovalPage): Row[] {
  const { budget } = view;
  const cur = view.amount?.currency ?? budget.currency;
  const amount = view.amount?.minor ?? 0;
  const after = budget.remainingMinor - amount;
  const merchant = view.merchant;
  return [
    [
      'Merchant',
      merchant === null ? '' : `${merchant.name}${merchant.category === null ? '' : ` · ${merchant.category}`}`,
    ],
    ['Amount', money(amount, cur)],
    ['Mandate left', `${money(budget.remainingMinor, cur)} of ${moneyShort(budget.totalMinor, cur)}`],
    ['After this', after >= 0 ? `${money(after, cur)} left` : `${money(-after, cur)} over budget`],
  ];
}

/** Task 044: a first purchase shows what the agent declared beside what the card network sent. */
function FirstPurchase({ facts }: { facts: NonNullable<ApprovalPage['firstPurchase']> }) {
  const { declared, observed } = facts;
  return (
    <>
      <p className="mt-5 text-[16px] md:text-[20px] leading-relaxed text-ink-2">
        Your agent hasn&apos;t bought from this shop before. Check that the charge matches what your agent declared.
        Nothing has been charged.
      </p>
      <h2 className="mt-7 text-[18px] sm:text-[20px] font-semibold">What your agent declared</h2>
      <div className="mt-3">
        <Rows
          rows={[
            ['Shop', declared.name],
            ['Website', declared.domain],
            ['Amount', money(declared.amountMinor, declared.currency)],
          ]}
        />
      </div>
      <h2 className="mt-7 text-[18px] sm:text-[20px] font-semibold">What the card network sent</h2>
      <div className="mt-3">
        <Rows
          rows={[
            ['Name on the charge', observed.descriptor],
            ['Merchant category', `${observed.category} · MCC ${observed.mcc}`],
            ['Country', observed.country],
          ]}
        />
      </div>
    </>
  );
}

function Choices({ options, choice, onChoice }: { options: Option[]; choice: Choice; onChoice: (c: Choice) => void }) {
  return (
    <div className="space-y-4" role="radiogroup" aria-label="What should happen?">
      {options.map(({ id, icon: Icon, title, body }) => {
        const on = choice === id;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => {
              onChoice(id);
            }}
            className={`w-full text-left rounded-2xl px-5 sm:px-6 py-4 sm:py-5 border transition ${on ? 'border-accent border-2 bg-accent-soft/50' : 'border-line bg-white hover:bg-canvas'}`}
          >
            <span className="flex items-center gap-3 text-[17px] sm:text-[19px] font-semibold">
              <Icon className="h-5 w-5" /> {title}
            </span>
            <span className="block mt-2 text-[15px] sm:text-[16px] leading-relaxed text-ink-2">{body}</span>
          </button>
        );
      })}
    </div>
  );
}

/** A purchase Levee held: over budget, or the first from a shop. */
export function StepUpApproval({ view, act, busy, error, onExpire }: ApprovalProps) {
  const [choice, setChoice] = useState<Choice>('allow-once');
  const amount = moneyShort(view.amount?.minor ?? 0, view.amount?.currency ?? view.budget.currency);
  const needsPasskey = choice !== 'deny';
  return (
    <div className="min-h-[100dvh] px-5 pt-7 pb-8 md:px-10 lg:px-[110px] md:py-12">
      <ApprovalHeader expiresAt={view.expiresAt} onExpire={onExpire} />
      <div className="mt-6 md:mt-10 grid grid-cols-1 lg:grid-cols-[1fr_612px] gap-8 lg:gap-12">
        <section>
          <span className="pill bg-amber-soft text-amber-ink text-[15px] px-4 py-2">
            <Hand className="h-4 w-4" />{' '}
            {view.firstPurchase !== null ? 'First purchase from this shop' : 'Purchase on hold'}
          </span>
          <h1 className="mt-6 text-[28px] md:text-[40px] xl:text-[52px] leading-[1.15] font-bold tracking-tight">
            {view.title}
          </h1>
          {view.firstPurchase !== null ? (
            <FirstPurchase facts={view.firstPurchase} />
          ) : (
            <>
              <p className="mt-5 text-[16px] md:text-[20px] leading-relaxed text-ink-2">
                Levee held this purchase because it&apos;s more than you have left in this mandate. Nothing has been
                charged.
              </p>
              <div className="mt-7">
                <Rows rows={heldRows(view)} />
              </div>
            </>
          )}
        </section>
        <section className="card p-5 sm:p-10 self-start">
          <h2 className="text-[24px] sm:text-[30px] font-bold tracking-tight mb-6">What should happen?</h2>
          <Choices options={optionsFor(view, amount)} choice={choice} onChoice={setChoice} />
          <button
            type="button"
            className={`${needsPasskey ? 'btn-primary' : 'btn-secondary border-rose-ink/30 text-rose-ink'} w-full mt-6 h-[60px] sm:h-[72px] text-[17px] sm:text-[19px]`}
            onClick={() => {
              act(choice);
            }}
            disabled={busy !== null}
          >
            <BusyIcon
              busy={busy !== null}
              icon={needsPasskey ? ScanFace : Ban}
              className={needsPasskey ? 'h-6 w-6' : 'h-5 w-5'}
            />
            {needsPasskey ? 'Continue with passkey' : 'Deny purchase'}
          </button>
          <InlineError>{error}</InlineError>
        </section>
      </div>
    </div>
  );
}

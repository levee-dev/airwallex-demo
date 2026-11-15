import { money, timeHM } from '../../lib/format';
import type { Dashboard } from '../../lib/types';

type Purchase = Dashboard['purchases'][number];

const OUTCOME: Record<Purchase['outcome'], { label: string; tone: string }> = {
  approved: { label: 'Paid', tone: 'text-accent' },
  needs_approval: { label: 'Waiting for you', tone: 'text-amber-ink' },
  unconfirmed: { label: 'Waiting for the issuer', tone: 'text-amber-ink' },
  declined: { label: 'Declined', tone: 'text-rose-ink' },
  failed: { label: 'Failed at the issuer', tone: 'text-rose-ink' },
};

function detail(purchase: Purchase): string {
  const reason = purchase.outcome === 'approved' ? undefined : purchase.reasons[0];
  return reason === undefined ? OUTCOME[purchase.outcome].label : `${OUTCOME[purchase.outcome].label}: ${reason}`;
}

export function Activity({ purchases }: { purchases: readonly Purchase[] }) {
  return (
    <section className="card p-5 sm:p-9">
      <h2 className="text-[20px] sm:text-[23px] font-semibold">Activity</h2>
      {purchases.length === 0 && <p className="mt-4 text-ink-2">Nothing yet. Ask your agent to buy something.</p>}
      <ul className="mt-4">
        {purchases.map((purchase) => (
          <li
            key={purchase.id}
            className="border-t border-line py-4 grid grid-cols-[56px_1fr_auto] sm:grid-cols-[72px_1fr_auto_220px] items-center gap-x-4 gap-y-1"
          >
            <span className="font-mono text-[14px] sm:text-[16px] text-ink-2">{timeHM(purchase.createdAt)}</span>
            <span className="text-[16px] sm:text-[18px] font-semibold truncate">
              {purchase.merchantName} · {purchase.item}
            </span>
            <span className="text-[16px] sm:text-[18px] text-right">
              {money(purchase.amountMinor, purchase.currency)}
            </span>
            <span
              className={`col-start-2 col-span-2 sm:col-start-auto sm:col-span-1 text-[14px] sm:text-[17px] sm:text-right font-medium ${OUTCOME[purchase.outcome].tone}`}
            >
              {detail(purchase)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

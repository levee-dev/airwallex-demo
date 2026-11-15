import { ArrowRight, BellRing } from 'lucide-react';
import { useCountdown } from '../../lib/use-countdown';
import type { Dashboard } from '../../lib/types';

export function AttentionBanner({ approval }: { approval: Dashboard['approvals'][number] }) {
  const { text } = useCountdown(approval.expiresAt);
  return (
    <div className="rounded-2xl bg-amber-soft px-5 sm:px-8 py-5 flex flex-wrap items-center gap-4">
      <BellRing className="h-6 w-6 text-amber-ink" />
      <p className="flex-1 min-w-[200px] text-[16px] sm:text-[19px] font-semibold text-amber-ink">
        {approval.title}. Link expires in {text}.
      </p>
      <a href={approval.url} className="btn-primary px-6">
        <ArrowRight className="h-5 w-5" /> Review
      </a>
    </div>
  );
}

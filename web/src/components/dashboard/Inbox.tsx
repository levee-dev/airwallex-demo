import { ago } from '../../lib/format';
import type { Dashboard } from '../../lib/types';

export function Inbox({ items }: { items: Dashboard['inbox'] }) {
  if (items.length === 0) return null;
  return (
    <section className="card p-5 sm:p-9">
      <h2 className="text-[20px] sm:text-[23px] font-semibold">Inbox</h2>
      <ul className="mt-4">
        {items.map((item) => (
          <li key={item.id} className="border-t border-line py-4 flex items-start gap-4">
            <span className={`mt-2 h-2.5 w-2.5 shrink-0 rounded-full ${item.read ? 'bg-ink-3/50' : 'bg-accent'}`} />
            <span className="flex-1 min-w-0">
              <span className="block text-[16px] sm:text-[18px] font-semibold">{item.title}</span>
              <span className="block text-[15px] sm:text-[16px] text-ink-2">{item.body}</span>
            </span>
            <span className="text-[14px] text-ink-2 whitespace-nowrap">{ago(item.createdAt)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

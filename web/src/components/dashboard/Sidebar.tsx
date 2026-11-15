import { useNavigate } from 'react-router';
import { Bot, FileCheck2, LayoutGrid, ReceiptText, Settings } from 'lucide-react';
import { Logo } from '../ui';

export const NAV = [
  { id: 'overview', label: 'Overview', icon: LayoutGrid },
  { id: 'mandates', label: 'Mandates', icon: FileCheck2 },
  { id: 'purchases', label: 'Purchases', icon: ReceiptText },
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'setup', label: 'Setup', icon: Settings },
] as const;

export type Tab = Exclude<(typeof NAV)[number]['id'], 'setup'>;

function initials(name: string): string {
  const letters = name
    .trim()
    .split(/\s+/)
    .map((part) => part[0] ?? '')
    .join('');
  return (letters.length > 1 ? `${letters[0] ?? ''}${letters.at(-1) ?? ''}` : name.slice(0, 2)).toUpperCase();
}

interface Props {
  readonly tab: Tab;
  readonly onTab: (tab: Tab) => void;
  readonly name: string;
  readonly onSignOut: () => void;
}

export function Sidebar({ tab, onTab, name, onSignOut }: Props) {
  const navigate = useNavigate();
  return (
    <aside className="bg-dark text-white lg:w-[380px] shrink-0 lg:min-h-screen lg:sticky lg:top-0 flex lg:flex-col px-4 py-3 lg:px-8 lg:py-10 items-center lg:items-stretch gap-3">
      <div className="lg:mb-10 shrink-0">
        <Logo dark soft size="sm" />
      </div>
      <nav className="flex lg:flex-col gap-1 overflow-x-auto no-scrollbar flex-1 lg:flex-none">
        {NAV.map(({ id, label, icon: Icon }) => {
          const active = tab === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => {
                if (id === 'setup') void navigate('/setup/agent');
                else onTab(id);
              }}
              className={`flex items-center gap-3 rounded-xl px-3 lg:px-5 h-11 lg:h-14 text-[15px] lg:text-[18px] whitespace-nowrap ${active ? 'bg-dark-2 text-white font-semibold' : 'text-white/70 hover:text-white'}`}
            >
              <Icon className={`h-5 w-5 ${active ? 'text-mint' : ''}`} />{' '}
              <span className={active ? '' : 'hidden sm:inline'}>{label}</span>
            </button>
          );
        })}
      </nav>
      <div className="hidden lg:flex mt-auto items-center gap-4">
        <span className="h-12 w-12 rounded-full bg-dark-2 text-mint grid place-items-center font-semibold">
          {initials(name)}
        </span>
        <div>
          <p className="text-[18px] font-semibold">{name}</p>
          <button type="button" onClick={onSignOut} className="text-[16px] text-white/65 hover:text-white">
            Sign out
          </button>
        </div>
      </div>
    </aside>
  );
}

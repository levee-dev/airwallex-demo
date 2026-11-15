import { useEffect } from 'react';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { api } from '../lib/api';
import { useAction } from '../lib/use-action';
import type { Account, User } from '../lib/types';
import { StatusPill } from './ui';

const POLL_MS = 2_500;

/**
 * The card account opening in the background since sign-up: opening, ready, or failed with a retry.
 * While it is opening the pill polls the server, so it turns green on its own.
 */
export function CardAccountPill({ user, onUser }: { user: User; onUser: (user: User) => void }) {
  const { busy, error, run } = useAction();
  const { status } = user.account;

  useEffect(() => {
    if (status !== 'opening') return undefined;
    const id = window.setInterval(() => {
      void api<{ account: Account }>('/api/account').then(
        ({ account }) => {
          if (account.status !== status) onUser({ ...user, account });
        },
        () => undefined,
      );
    }, POLL_MS);
    return () => {
      window.clearInterval(id);
    };
  }, [status, user, onUser]);

  const retry = () =>
    run('retry', async () => {
      onUser((await api<{ user: User }>('/api/account/provision', { body: {} })).user);
    });

  if (status === 'ready') {
    return (
      <StatusPill tone="ok" icon={CheckCircle2}>
        Card account ready
      </StatusPill>
    );
  }
  if (status === 'opening' || busy === 'retry') {
    return (
      <StatusPill tone="wait">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Opening card account…
      </StatusPill>
    );
  }
  return (
    <StatusPill tone="bad" icon={AlertCircle}>
      <span title={error ?? user.account.error ?? undefined}>Couldn&apos;t open card account</span>
      <span aria-hidden="true">·</span>
      <button type="button" className="font-semibold underline underline-offset-2" onClick={() => void retry()}>
        Retry
      </button>
    </StatusPill>
  );
}

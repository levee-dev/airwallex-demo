import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { MandateApproval } from '../components/approve/MandateApproval';
import { Result, isResultKind, type ResultKind } from '../components/approve/Result';
import { StepUpApproval } from '../components/approve/StepUpApproval';
import { SpinnerPage, Unavailable } from '../components/ui';
import { api, ApiError, errorMessage } from '../lib/api';
import { decideWithPasskey } from '../lib/passkeys';
import type { ApprovalAction, ApprovalPage } from '../lib/types';

const NEEDS_PASSKEY: readonly ApprovalAction[] = ['approve', 'allow-once', 'allow-from-now-on'];

/** A dead link is shown as its own screen, never as an error under a form. */
function deadLink(error: unknown): ResultKind | null {
  if (!(error instanceof ApiError)) return null;
  if (error.code === 'link_used') return 'used';
  if (error.code === 'link_expired') return 'expired';
  if (error.code === 'link_not_found') return 'invalid';
  return null;
}

function useApproval(token: string) {
  const [view, setView] = useState<ApprovalPage | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  useEffect(() => {
    let live = true;
    api<ApprovalPage>(`/api/approvals/${encodeURIComponent(token)}`).then(
      (next) => {
        if (live) setView(next);
      },
      (failure: unknown) => {
        if (live) setLoadError(failure ?? new Error('failed'));
      },
    );
    return () => {
      live = false;
    };
  }, [token]);
  return { view, loadError };
}

/** Opened from the link an agent shows the person. Works on any device; only the passkey decides. */
export function ApprovePage() {
  const { token = '' } = useParams();
  const { view, loadError } = useApproval(token);
  const [busy, setBusy] = useState<ApprovalAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ResultKind | null>(null);

  const onExpire = useCallback(() => {
    setResult((current) => current ?? 'expired');
  }, []);

  const act = async (action: ApprovalAction) => {
    if (busy !== null) return;
    setBusy(action);
    setError(null);
    try {
      const outcome = NEEDS_PASSKEY.includes(action)
        ? await decideWithPasskey(token, action)
        : await api<{ status: string }>(`/api/approvals/${encodeURIComponent(token)}/${action}`, { body: {} });
      setResult(isResultKind(outcome.status) ? outcome.status : 'approved');
    } catch (failure) {
      const dead = deadLink(failure);
      if (dead === null) setError(errorMessage(failure));
      else setResult(dead);
    } finally {
      setBusy(null);
    }
  };

  const agent = view?.agent.name ?? 'Your agent';
  if (result !== null) return <Result kind={result} agent={agent} />;
  if (loadError !== null) {
    const dead = deadLink(loadError);
    if (dead !== null) return <Result kind={dead} />;
    return (
      <Unavailable
        message={errorMessage(loadError)}
        onRetry={() => {
          window.location.reload();
        }}
      />
    );
  }
  // An already-expired link fires onExpire on the countdown's first tick.
  if (view === null) return <SpinnerPage />;

  const props = { view, act: (action: ApprovalAction) => void act(action), busy, error, onExpire };
  return view.kind === 'step_up' ? <StepUpApproval {...props} /> : <MandateApproval {...props} />;
}

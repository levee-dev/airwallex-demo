import { useCallback, useState } from 'react';
import { errorMessage } from './api';

/** Runs one labelled action at a time and keeps its error message. */
export function useAction() {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (label: string, action: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy('');
    }
  }, []);
  return { busy, error, run };
}

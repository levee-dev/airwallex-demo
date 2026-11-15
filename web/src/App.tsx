import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { SpinnerPage, Unavailable } from './components/ui';
import { api, ApiError, errorMessage, setCsrfToken } from './lib/api';
import { destination, firstOpenStep, safeNext, setupComplete } from './lib/setup';
import type { SessionResponse, User } from './lib/types';
import { ApprovePage } from './pages/ApprovePage';
import { AuthPage } from './pages/AuthPage';
import { DashboardPage } from './pages/DashboardPage';
import { SetupPage } from './pages/SetupPage';

type Session =
  | { status: 'loading' }
  | { status: 'signed_out' }
  | { status: 'unavailable'; message: string }
  | { status: 'signed_in'; user: User };

function useSession() {
  const [session, setSession] = useState<Session>({ status: 'loading' });

  const signedIn = useCallback((response: SessionResponse) => {
    setCsrfToken(response.csrfToken);
    setSession({ status: 'signed_in', user: response.user });
  }, []);

  // Only a 401 means signed out; anything else is an outage and never shows the sign-in form.
  const refresh = useCallback(
    () =>
      api<SessionResponse>('/api/auth/me').then(signedIn, (failure: unknown) => {
        setSession(
          failure instanceof ApiError && failure.status === 401
            ? { status: 'signed_out' }
            : { status: 'unavailable', message: errorMessage(failure) },
        );
      }),
    [signedIn],
  );

  const signOut = useCallback(async () => {
    try {
      await api('/api/auth/logout', { body: {} });
    } finally {
      setCsrfToken(null);
      setSession({ status: 'signed_out' });
    }
  }, []);

  const updateUser = useCallback((user: User) => {
    setSession({ status: 'signed_in', user });
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { session, signedIn, refresh, signOut, updateUser };
}

export function App() {
  const { session, signedIn, refresh, signOut, updateUser } = useSession();
  const location = useLocation();

  if (session.status === 'loading') {
    return (
      <Routes>
        <Route path="/approve/:token" element={<ApprovePage />} />
        <Route path="*" element={<SpinnerPage />} />
      </Routes>
    );
  }
  if (session.status === 'unavailable') {
    return (
      <Routes>
        <Route path="/approve/:token" element={<ApprovePage />} />
        <Route path="*" element={<Unavailable message={session.message} onRetry={() => void refresh()} />} />
      </Routes>
    );
  }

  const user = session.status === 'signed_in' ? session.user : null;
  const signedOutOnly = (mode: 'signin' | 'signup') =>
    user === null ? (
      <AuthPage mode={mode} onSignedIn={signedIn} />
    ) : (
      // A phone that scanned the setup QR code signs in and lands back on that step.
      <Navigate to={(user.hasPasskey ? safeNext(location.search) : null) ?? destination(user)} replace />
    );
  const signedInOnly = (render: (user: User) => ReactNode) =>
    user === null ? <Navigate to="/signin" replace /> : render(user);

  return (
    <Routes>
      <Route path="/approve/:token" element={<ApprovePage />} />
      <Route
        path="/"
        element={user === null ? <Navigate to="/setup/account" replace /> : <Navigate to={destination(user)} replace />}
      />
      <Route path="/signin" element={signedOutOnly('signin')} />
      <Route path="/setup/account" element={signedOutOnly('signup')} />
      <Route
        path="/setup"
        element={signedInOnly((u) => (
          <Navigate to={firstOpenStep(u)} replace />
        ))}
      />
      <Route
        path="/setup/:step"
        element={signedInOnly((u) => (
          <SetupPage user={u} onUser={updateUser} />
        ))}
      />
      <Route
        path="/dashboard"
        element={signedInOnly((u) =>
          setupComplete(u) ? (
            <DashboardPage user={u} onUser={updateUser} onSignOut={() => void signOut()} />
          ) : (
            <Navigate to={firstOpenStep(u)} replace />
          ),
        )}
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

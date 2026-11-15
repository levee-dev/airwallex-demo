import { useState, type SubmitEvent } from 'react';
import { Link } from 'react-router';
import { ArrowRight, KeyRound, Lock, Mail, ScanFace, Terminal, UserRound } from 'lucide-react';
import { BusyIcon, Field, Logo } from '../components/ui';
import { api, ApiError, errorMessage } from '../lib/api';
import type { SessionResponse } from '../lib/types';

const PASSWORD_MIN = 12;

const FEATURES = [
  { icon: KeyRound, text: 'Agent tokens shown once, stored only as a hash' },
  { icon: ScanFace, text: 'Passkey approval for every mandate' },
  { icon: Terminal, text: 'Five-minute setup, nothing to install' },
];

function Hero() {
  return (
    <section className="bg-dark text-white px-6 py-8 sm:px-12 lg:px-[100px] lg:py-[86px] flex flex-col">
      <Logo dark soft />
      <div className="mt-10 lg:mt-auto">
        <h2 className="text-[34px] sm:text-[46px] lg:text-[58px] leading-[1.12] font-bold tracking-tight">
          Let your AI agent shop. You keep the keys.
        </h2>
        <p className="mt-6 text-[17px] sm:text-[20px] leading-relaxed text-white/65 max-w-[640px]">
          Connect Claude, Codex, Cursor or any MCP agent in one step. Every purchase is checked by Levee and approved
          with your passkey.
        </p>
        <ul className="mt-8 space-y-4 hidden sm:block">
          {FEATURES.map(({ icon: Icon, text }) => (
            <li key={text} className="flex items-center gap-4 text-[17px] sm:text-[19px] text-white/90">
              <Icon className="h-6 w-6 text-mint" /> {text}
            </li>
          ))}
        </ul>
      </div>
      <div className="hidden lg:block h-[60px]" />
    </section>
  );
}

/** Sign up and sign in for Acme Pay's end users: step 1 of setup. */
export function AuthPage({
  mode,
  onSignedIn,
}: {
  mode: 'signin' | 'signup';
  onSignedIn: (s: SessionResponse) => void;
}) {
  const signIn = mode === 'signin';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; taken: boolean } | null>(null);

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const field = (name: string) => {
      const value = form.get(name);
      return typeof value === 'string' ? value : '';
    };
    const password = field('password');
    if (!signIn && password.length < PASSWORD_MIN) {
      setError({ message: `Use at least ${PASSWORD_MIN} characters for the password.`, taken: false });
      return;
    }
    const body = signIn
      ? { email: field('email').trim(), password }
      : { name: field('name').trim(), email: field('email').trim(), password };
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await api<SessionResponse>(signIn ? '/api/auth/login' : '/api/auth/signup', { body }));
    } catch (failure) {
      setError({ message: errorMessage(failure), taken: failure instanceof ApiError && failure.status === 409 });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[44%_56%]">
      <Hero />
      <section className="flex items-center justify-center px-6 py-10 sm:px-12">
        <form onSubmit={(event) => void submit(event)} className="w-full max-w-[612px]" noValidate>
          <h1 className="text-[32px] sm:text-[40px] font-bold tracking-tight">
            {signIn ? 'Sign in to Acme Pay' : 'Create your Acme Pay account'}
          </h1>
          <Link
            to={signIn ? '/setup/account' : '/signin'}
            className="inline-block mt-4 text-[17px] sm:text-[19px] font-semibold text-accent hover:underline"
          >
            {signIn ? 'New here? Create an account' : 'Already have one? Sign in'}
          </Link>
          <div className="mt-8 space-y-6">
            {!signIn && (
              <Field
                label="Full name"
                icon={UserRound}
                name="name"
                autoComplete="name"
                placeholder="Alex Morgan"
                maxLength={80}
                required
              />
            )}
            <Field
              label="Email"
              icon={Mail}
              name="email"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              required
            />
            <Field
              label="Password"
              icon={Lock}
              name="password"
              type="password"
              autoComplete={signIn ? 'current-password' : 'new-password'}
              placeholder="••••••••••••"
              hint={signIn ? undefined : `At least ${PASSWORD_MIN} characters.`}
              minLength={signIn ? undefined : PASSWORD_MIN}
              required
            />
          </div>
          <button type="submit" className="btn-primary w-full mt-8 h-[60px] text-[17px]" disabled={busy}>
            <BusyIcon busy={busy} icon={ArrowRight} />
            {signIn ? 'Sign in' : 'Create account'}
          </button>
          {error !== null && (
            <div className="mt-5 flex flex-wrap items-center gap-3 rounded-lg bg-rose-soft px-3 py-2" role="alert">
              <p className="text-[14px] text-rose-ink">{error.message}</p>
              {error.taken && (
                <Link to="/signin" className="text-[14px] font-semibold text-rose-ink underline">
                  Sign in
                </Link>
              )}
            </div>
          )}
          <p className="mt-6 text-[14px] sm:text-[15px] leading-relaxed text-ink-2">
            Sandbox only. No real money moves, and your agent never sees your password or passkey.
          </p>
        </form>
      </section>
    </div>
  );
}

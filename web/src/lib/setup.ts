import type { User } from './types';

/**
 * The end user's setup wizard. The card account opens in the background from sign-up, so it is not
 * a step; its status shows as a pill. The operator's Levee and Airwallex keys are set with
 * `npm run setup`.
 */
export const SETUP_STEPS = [
  { id: 'account', title: 'Account', sub: 'Email and password' },
  { id: 'passkey', title: 'Passkey', sub: 'Approves every mandate' },
  { id: 'phone', title: 'Phone', sub: 'Approval notifications' },
  { id: 'agent', title: 'Agent', sub: 'Claude, Codex, Cursor or any MCP client' },
] as const;

export type SetupStepId = (typeof SETUP_STEPS)[number]['id'];

export function accountReady(user: User): boolean {
  return user.account.status === 'ready';
}

/** The passkey is what an agent needs before it can ask to spend; the phone step is optional. */
export function setupComplete(user: User): boolean {
  return user.hasPasskey;
}

/** A step is ticked only from saved state, never because it was visited. */
export function stepDone(id: SetupStepId, user: User | null): boolean {
  if (user === null) return false;
  switch (id) {
    case 'account':
      return true;
    case 'passkey':
      return user.hasPasskey;
    case 'phone':
      return user.phoneNotifications;
    case 'agent':
      return setupComplete(user);
  }
}

export function firstOpenStep(user: User): string {
  if (!user.hasPasskey) return '/setup/passkey';
  if (!user.phoneNotifications) return '/setup/phone';
  return '/setup/agent';
}

/** Where a signed-in person belongs: the dashboard once set up, otherwise their first open step. */
export function destination(user: User): string {
  return setupComplete(user) ? '/dashboard' : firstOpenStep(user);
}

/** An in-app path from `?next=`, so a phone that scanned the setup QR lands back on its step. */
export function safeNext(search: string): string | null {
  const next = new URLSearchParams(search).get('next');
  if (next === null || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return null;
  return /^\/(setup\/[a-z-]+|dashboard)$/.test(next) ? next : null;
}

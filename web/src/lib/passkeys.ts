import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { api } from './api';
import { withHybridHint } from './passkey-hints';
import type { ApprovalAction } from './types';

type RegistrationOptions = Parameters<typeof startRegistration>[0]['optionsJSON'];
type AuthenticationOptions = Parameters<typeof startAuthentication>[0]['optionsJSON'];

/**
 * Levee issues the options and verifies the result; the browser only runs the ceremony.
 * `phone`: create the passkey on a phone over hybrid transport (Chrome shows a QR code to scan).
 */
export async function enrolPasskey({ phone = false }: { phone?: boolean } = {}): Promise<void> {
  const { requestId, options } = await api<{ requestId: string; options: RegistrationOptions }>(
    '/api/passkeys/options',
    {
      body: {},
    },
  );
  const response = await startRegistration({ optionsJSON: phone ? withHybridHint(options) : options });
  await api('/api/passkeys', { body: { requestId, response } });
}

/** Runs the passkey ceremony for an approval-link action, then submits the decision. */
export async function decideWithPasskey(token: string, action: ApprovalAction): Promise<{ status: string }> {
  const { requestId, options } = await api<{ requestId: string; options: AuthenticationOptions }>(
    `/api/approvals/${encodeURIComponent(token)}/options`,
    { body: { action } },
  );
  const response = await startAuthentication({ optionsJSON: options });
  return api(`/api/approvals/${encodeURIComponent(token)}/${action}`, { body: { requestId, response } });
}

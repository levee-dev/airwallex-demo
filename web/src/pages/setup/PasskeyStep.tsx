import { useNavigate } from 'react-router';
import { ArrowRight, CheckCircle2, Fingerprint, ScanFace, Smartphone } from 'lucide-react';
import { browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { CardAccountPill } from '../../components/CardAccountPill';
import { StepShell } from '../../components/SetupLayout';
import { BusyIcon, InlineError, StatusPill } from '../../components/ui';
import { enrolPasskey } from '../../lib/passkeys';
import { useAction } from '../../lib/use-action';
import type { User } from '../../lib/types';

export function PasskeyStep({ user, onUser }: { user: User; onUser: (user: User) => void }) {
  const navigate = useNavigate();
  const { busy, error, run } = useAction();
  const supported = browserSupportsWebAuthn();

  const enrol = (phone: boolean) =>
    run(phone ? 'phone' : 'passkey', async () => {
      await enrolPasskey({ phone });
      onUser({ ...user, hasPasskey: true });
    });

  return (
    <StepShell
      step="passkey"
      user={user}
      title="Add your passkey"
      intro="Every mandate your agent asks for is approved with your passkey: Face ID, Touch ID, Windows Hello, your phone or a security key. Your agent can never use it."
      status={<CardAccountPill user={user} onUser={onUser} />}
      footer={
        <button
          type="button"
          className="btn-primary px-8 ml-auto"
          disabled={!user.hasPasskey}
          onClick={() => void navigate('/setup/phone')}
        >
          <ArrowRight className="h-5 w-5" /> Continue
        </button>
      }
    >
      <div className="rounded-xl border border-line bg-canvas p-4 flex flex-wrap items-center gap-4">
        <Fingerprint className="h-6 w-6 text-accent" />
        <div className="flex-1 min-w-[200px]">
          <p className="font-semibold">{user.hasPasskey ? 'Your passkey is ready' : 'Create your passkey'}</p>
          <p className="text-[14px] text-ink-2">Levee verifies it. Acme never sees the key itself.</p>
        </div>
        {user.hasPasskey ? (
          <StatusPill tone="ok" icon={CheckCircle2}>
            Passkey added
          </StatusPill>
        ) : (
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              className="btn-secondary h-11"
              disabled={busy !== '' || !supported}
              onClick={() => void enrol(true)}
            >
              <BusyIcon busy={busy === 'phone'} icon={Smartphone} /> Use my phone
            </button>
            <button
              type="button"
              className="btn-primary h-11"
              disabled={busy !== '' || !supported}
              onClick={() => void enrol(false)}
            >
              <BusyIcon busy={busy === 'passkey'} icon={ScanFace} /> Create passkey
            </button>
          </div>
        )}
      </div>
      {!user.hasPasskey && (
        <p className="mt-3 text-[14px] text-ink-2">
          {supported
            ? 'Use my phone: scan the QR code with your phone’s camera. Bluetooth must be on for both devices.'
            : 'This browser cannot create passkeys. Open Acme Pay in a current version of Chrome, Safari, Edge or Firefox.'}
        </p>
      )}
      <InlineError>{error}</InlineError>
    </StepShell>
  );
}

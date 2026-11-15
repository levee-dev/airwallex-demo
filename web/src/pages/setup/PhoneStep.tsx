import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import QRCode from 'qrcode';
import { ArrowRight, BellRing, CheckCircle2, Info, Send, Share, SquarePlus } from 'lucide-react';
import { CardAccountPill } from '../../components/CardAccountPill';
import { BackButton, StepShell } from '../../components/SetupLayout';
import { BusyIcon, InlineError, Spinner, StatusPill } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { deviceKind, enableNotifications, isStandalone, phoneLink, publicHttps, pushSupported } from '../../lib/push';
import { useAction } from '../../lib/use-action';
import type { PushDevice, PushInfo, User } from '../../lib/types';

const POLL_MS = 3_000;

function usePushInfo(poll: boolean) {
  const [info, setInfo] = useState<PushInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    () =>
      api<PushInfo>('/api/push').then(
        (next) => {
          setInfo(next);
          setError(null);
        },
        (failure: unknown) => {
          setError(errorMessage(failure));
        },
      ),
    [],
  );
  useEffect(() => {
    void load();
    if (!poll) return undefined;
    const id = window.setInterval(() => void load(), POLL_MS);
    return () => {
      window.clearInterval(id);
    };
  }, [load, poll]);
  return { info, error, setInfo };
}

function Notice({ children }: { children: string }) {
  return (
    <div className="rounded-xl border border-line bg-canvas p-4 flex items-start gap-3">
      <Info className="h-5 w-5 mt-0.5 text-accent shrink-0" />
      <p className="text-[15px] text-ink-2">{children}</p>
    </div>
  );
}

/** A QR code of the app's public URL, rendered in the browser. */
function PhoneQr({ url }: { url: string }) {
  const [image, setImage] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void QRCode.toDataURL(url, { margin: 1, width: 440, color: { dark: '#10251E', light: '#FFFFFF' } }).then((data) => {
      if (live) setImage(data);
    });
    return () => {
      live = false;
    };
  }, [url]);
  return (
    <div className="h-[220px] w-[220px] shrink-0 rounded-2xl border border-line bg-white p-3 grid place-items-center">
      {image === null ? (
        <Spinner className="h-6 w-6 text-ink-2" />
      ) : (
        <img src={image} alt="QR code to open Acme Pay on your phone" className="h-full w-full" />
      )}
    </div>
  );
}

function IosSteps() {
  return (
    <div>
      <p className="text-[17px] sm:text-[18px] font-semibold">First, add Acme Pay to your Home Screen</p>
      <p className="mt-1 text-[15px] text-ink-2">iPhone only sends notifications to apps on the Home Screen.</p>
      <ol className="mt-5 space-y-4">
        <li className="flex items-start gap-4">
          <span className="h-9 w-9 shrink-0 rounded-full bg-accent-soft text-accent grid place-items-center font-semibold">
            1
          </span>
          <p className="pt-1.5 text-[16px]">
            Tap <Share className="inline h-5 w-5 -mt-1 text-accent" aria-label="Share" /> <strong>Share</strong> in
            Safari&apos;s toolbar.
          </p>
        </li>
        <li className="flex items-start gap-4">
          <span className="h-9 w-9 shrink-0 rounded-full bg-accent-soft text-accent grid place-items-center font-semibold">
            2
          </span>
          <p className="pt-1.5 text-[16px]">
            Choose <SquarePlus className="inline h-5 w-5 -mt-1 text-accent" aria-hidden="true" />{' '}
            <strong>Add to Home Screen</strong>, then open Acme Pay from your Home Screen, sign in and come back to this
            step.
          </p>
        </li>
      </ol>
    </div>
  );
}

function DeviceStatus({ devices }: { devices: readonly PushDevice[] }) {
  if (devices.length === 0) {
    return <StatusPill tone="neutral">No phone yet</StatusPill>;
  }
  return (
    <div className="flex flex-wrap gap-2">
      {devices.map((device) => (
        <StatusPill key={device.id} tone="ok" icon={CheckCircle2}>
          Notifications on for {device.label}
        </StatusPill>
      ))}
    </div>
  );
}

/**
 * Optional: approval requests as notifications on the person's phone. On a computer the step shows a
 * QR code of the app's public URL; on the phone it subscribes (after Add to Home Screen on iPhone).
 */
export function PhoneStep({ user, onUser }: { user: User; onUser: (user: User) => void }) {
  const navigate = useNavigate();
  const { busy, error, run } = useAction();
  const kind = deviceKind();
  const onPhone = kind !== 'desktop';
  const { info, error: loadError, setInfo } = usePushInfo(!onPhone);
  const [sent, setSent] = useState(false);
  const devices = info?.devices ?? [];
  const reachable = info !== null && publicHttps(info.publicUrl, window.location);
  const needsHomeScreen = kind === 'iphone' && !isStandalone();

  useEffect(() => {
    if (info === null) return;
    const on = info.devices.length > 0;
    if (on !== user.phoneNotifications) onUser({ ...user, phoneNotifications: on });
  }, [info, user, onUser]);

  const allow = () =>
    run('allow', async () => {
      if (info?.publicKey == null) throw new Error('Phone notifications are not set up on this server.');
      const next = await enableNotifications(info.publicKey);
      setInfo({ ...info, devices: next });
    });

  const test = () =>
    run('test', async () => {
      setSent(false);
      await api('/api/push/test', { body: {} });
      setSent(true);
    });

  let body;
  if (info === null) {
    body = loadError === null ? <Spinner className="h-6 w-6 text-ink-2" /> : null;
  } else if (!info.configured) {
    body = (
      <Notice>
        Phone notifications are not set up on this server yet. The operator runs npm run setup, which creates the
        notification keys.
      </Notice>
    );
  } else if (!reachable) {
    body = (
      <Notice>
        Phone notifications need a public HTTPS URL. Run npm run dev (it opens a tunnel) and open the printed URL.
      </Notice>
    );
  } else if (!onPhone) {
    body = (
      <div className="flex flex-col sm:flex-row gap-6 sm:items-center">
        <PhoneQr url={phoneLink(info.publicUrl)} />
        <div className="space-y-3">
          <p className="text-[17px] sm:text-[18px] font-semibold">Scan with your phone&apos;s camera</p>
          <p className="text-[15px] text-ink-2 max-w-[460px]">
            It opens Acme Pay on your phone. Sign in with your email and password, then allow notifications there. On
            iPhone, add it to your Home Screen first; the phone shows you how.
          </p>
          <p className="text-[13px] text-ink-3 break-all">{info.publicUrl}</p>
        </div>
      </div>
    );
  } else if (needsHomeScreen) {
    body = <IosSteps />;
  } else if (!pushSupported()) {
    body = (
      <Notice>This browser cannot receive notifications. Open Acme Pay in Chrome or from your Home Screen.</Notice>
    );
  } else {
    body = (
      <div className="space-y-3">
        <p className="text-[17px] sm:text-[18px] font-semibold">Get approval requests on this phone</p>
        <p className="text-[15px] text-ink-2">
          When your agent asks for a mandate or a purchase needs you, tap the notification to review and approve with
          your passkey.
        </p>
        <button type="button" className="btn-primary" disabled={busy !== ''} onClick={() => void allow()}>
          <BusyIcon busy={busy === 'allow'} icon={BellRing} /> Allow notifications
        </button>
      </div>
    );
  }

  return (
    <StepShell
      step="phone"
      user={user}
      title="Get approvals on your phone"
      intro="Your agent's requests reach you as a notification, so you can approve them wherever you are. This step is optional."
      status={<CardAccountPill user={user} onUser={onUser} />}
      footer={
        <>
          <BackButton to="/setup/passkey" />
          <div className="flex flex-wrap items-center gap-4 ml-auto">
            {devices.length === 0 && (
              <button type="button" className="btn-secondary px-6" onClick={() => void navigate('/setup/agent')}>
                Skip for now
              </button>
            )}
            <button
              type="button"
              className="btn-primary px-8"
              disabled={devices.length === 0}
              onClick={() => void navigate('/setup/agent')}
            >
              <ArrowRight className="h-5 w-5" /> Continue
            </button>
          </div>
        </>
      }
    >
      {body}
      {info?.configured === true && (reachable || devices.length > 0) && (
        <>
          <div className="my-7 h-px bg-line" />
          <div className="flex flex-wrap items-center gap-4">
            <DeviceStatus devices={devices} />
            {devices.length > 0 && (
              <button
                type="button"
                className="btn-secondary h-11 ml-auto"
                disabled={busy !== ''}
                onClick={() => void test()}
              >
                <BusyIcon busy={busy === 'test'} icon={Send} /> Send test notification
              </button>
            )}
          </div>
          {sent && <p className="mt-3 text-[14px] text-ink-2">Sent. It should arrive in a few seconds.</p>}
        </>
      )}
      <InlineError>{error ?? loadError}</InlineError>
    </StepShell>
  );
}

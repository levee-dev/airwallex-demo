import { api } from './api';
import type { PushDevice } from './types';

/**
 * Phone notifications for approvals over Web Push. The service worker (`/sw.js`) shows them and
 * opens the approval page when one is tapped.
 */

export type DeviceKind = 'iphone' | 'android' | 'desktop';

export function deviceKind(): DeviceKind {
  const ua = navigator.userAgent;
  // iPadOS reports itself as a Mac; touch points give it away.
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iphone';
  if (/Android/.test(ua)) return 'android';
  return 'desktop';
}

/** Opened from the home screen, not a browser tab. iOS only allows Web Push there. */
export function isStandalone(): boolean {
  const legacy = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return legacy || window.matchMedia('(display-mode: standalone)').matches;
}

export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Whether the phone flow can run: the page is served over HTTPS on a public host, and so is the
 * app's public URL the QR code points at. On localhost a phone has nothing it could open.
 */
export function publicHttps(publicUrl: string, location: Pick<Location, 'protocol' | 'hostname'>): boolean {
  let target: URL;
  try {
    target = new URL(publicUrl);
  } catch {
    return false;
  }
  const local = (host: string) => LOOPBACK.has(host) || host.endsWith('.localhost');
  return (
    location.protocol === 'https:' &&
    !local(location.hostname) &&
    target.protocol === 'https:' &&
    !local(target.hostname)
  );
}

/**
 * The QR code's target: the app's public URL, signing in and landing on this step. It carries no
 * credential, so a photo of the screen gives nothing away; the phone signs in with the password.
 */
export function phoneLink(publicUrl: string): string {
  return `${publicUrl}/signin?next=${encodeURIComponent('/setup/phone')}`;
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch {
    return null;
  }
}

function applicationServerKey(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = `${base64url}${'='.repeat((4 - (base64url.length % 4)) % 4)}`.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export class PushPermissionError extends Error {}

/** Asks for permission, subscribes this browser and saves the subscription on the server. */
export async function enableNotifications(publicKey: string): Promise<PushDevice[]> {
  if (!pushSupported()) throw new PushPermissionError('This browser cannot receive notifications.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new PushPermissionError(
      permission === 'denied'
        ? 'Notifications are blocked. Allow them for this site in your settings, then try again.'
        : 'Notifications were not allowed.',
    );
  }
  const registration = (await registerServiceWorker()) ?? (await navigator.serviceWorker.ready);
  await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey(publicKey),
    }));
  const saved = await api<{ devices: PushDevice[] }>('/api/push/subscriptions', {
    body: { subscription: subscription.toJSON() },
  });
  return saved.devices;
}

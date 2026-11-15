/*
 * Acme Pay service worker: shows approval notifications pushed by the server and opens the
 * approval page when one is tapped. It caches nothing; the app always loads from the network.
 */

self.addEventListener('install', () => {
  void self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

/** Only this app's own pages are opened; anything else falls back to the dashboard. */
function appUrl(raw) {
  try {
    const url = new URL(raw, self.location.origin);
    if (url.origin === self.location.origin) return url.href;
  } catch {
    // Not a URL.
  }
  return new URL('/dashboard', self.location.origin).href;
}

self.addEventListener('push', (event) => {
  let message;
  try {
    message = event.data ? event.data.json() : {};
  } catch {
    message = { body: event.data ? event.data.text() : '' };
  }
  const title = typeof message.title === 'string' && message.title ? message.title : 'Acme Pay';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof message.body === 'string' ? message.body : '',
      tag: typeof message.tag === 'string' ? message.tag : undefined,
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      data: { url: appUrl(message.url) },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = appUrl(event.notification.data && event.notification.data.url);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const exact = windows.find((client) => client.url === target);
      if (exact) return exact.focus();
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
      if (open) {
        await open.focus();
        return open.navigate(target);
      }
      return self.clients.openWindow(target);
    })(),
  );
});

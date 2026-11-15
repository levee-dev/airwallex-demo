import webpush from 'web-push';
import { AirwallexClient } from './airwallex/client';
import type { AppConfig } from './config';
import type { AppContext, PushSender } from './context';
import type { Database } from './db/client';
import { createDecisionModel } from './decision-model/client';
import { Platform } from './platform/platform';

/** Web Push through the `web-push` library: VAPID-signed, payload encrypted for the subscription. */
export const webPushSender: PushSender = {
  async send(target, payload, vapid) {
    await webpush.sendNotification(
      { endpoint: target.endpoint, keys: { p256dh: target.keys.p256dh, auth: target.keys.auth } },
      payload,
      {
        vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
        TTL: 15 * 60,
        urgency: 'high',
        timeout: 10_000,
      },
    );
  },
};

export function createContext(config: AppConfig, db: Database): AppContext {
  return {
    db,
    encryptionKey: config.encryptionKey,
    publicUrl: config.publicUrl,
    secureCookies: config.publicUrl.startsWith('https:'),
    trustProxy: config.trustProxy,
    platform: new Platform(db, config),
    airwallex: new AirwallexClient({ baseUrl: config.airwallexBaseUrl }),
    decisionModel: config.decisionModel === null ? null : createDecisionModel(config.decisionModel),
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    push: webPushSender,
  };
}

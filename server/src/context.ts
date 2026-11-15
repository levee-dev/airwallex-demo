import type { AirwallexClient } from './airwallex/client';
import type { Database } from './db/client';
import type { DecisionModel } from './decision-model/client';
import type { Platform } from './platform/platform';

/** Everything a request handler needs, created once at startup (or per test). */
export interface AppContext {
  readonly db: Database;
  readonly encryptionKey: Buffer;
  /** The web app origin; approval links and the MCP URL are built from it. */
  readonly publicUrl: string;
  readonly secureCookies: boolean;
  readonly trustProxy: boolean;
  readonly platform: Platform;
  readonly airwallex: AirwallexClient;
  /** Optional; null unless SYSTEM_ONE_* is configured. It may only tighten. */
  readonly decisionModel: DecisionModel | null;
  readonly now: () => Date;
  /** Waits between background retries; tests pass a no-op. */
  readonly sleep: (ms: number) => Promise<void>;
  /** Delivers Web Push messages; tests pass a fake. */
  readonly push: PushSender;
}

export interface PushTarget {
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
}

export interface VapidKeys {
  readonly subject: string;
  readonly publicKey: string;
  readonly privateKey: string;
}

/** Sends one encrypted Web Push message. Rejects with the push service's HTTP status when it refuses. */
export interface PushSender {
  send(target: PushTarget, payload: string, vapid: VapidKeys): Promise<void>;
}

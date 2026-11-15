import type { RegisteredWebhookEndpoint } from '../platform/platform';
import { asString, isRecord } from '../lib/values';
import { WEBHOOK_EVENT_TYPES } from './events';

/** The path Levee delivers to, on whatever public origin reaches this server. */
export const WEBHOOK_PATH = '/webhooks/levee';

/**
 * A Cloudflare quick tunnel hostname, as cloudflared prints it once the tunnel is up. Quick tunnel
 * names are hyphenated words, which keeps `api.trycloudflare.com` (also in its log) from matching.
 */
const QUICK_TUNNEL_URL = /https:\/\/([a-z0-9]+(?:-[a-z0-9]+)+)\.trycloudflare\.com\b/i;

/** The quick tunnel origin in a chunk of cloudflared output, or null when there is none yet. */
export function parseQuickTunnelUrl(output: string): string | null {
  const match = QUICK_TUNNEL_URL.exec(output);
  return match === null ? null : `https://${(match[1] ?? '').toLowerCase()}.trycloudflare.com`;
}

/** The webhook URL for a public origin. */
export function webhookUrlFor(origin: string): string {
  const url = new URL(origin);
  if (url.protocol !== 'https:') throw new Error('The public webhook origin must use https');
  return new URL(WEBHOOK_PATH, url.origin).toString();
}

/** The parts of the Levee client this needs; the platform key authenticates both calls. */
export interface WebhookEndpointApi {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}

export interface EnsureWebhookEndpointResult {
  readonly endpoint: RegisteredWebhookEndpoint;
  /** True when a new endpoint was registered, false when the saved one already matched. */
  readonly registered: boolean;
  /** Other active endpoints of this platform that point at a quick tunnel, from earlier runs. */
  readonly staleTunnelEndpoints: number;
}

interface ListedEndpoint {
  readonly id: string;
  readonly url: string;
  readonly events: readonly string[];
}

function listed(value: unknown): ListedEndpoint[] {
  if (!Array.isArray(value)) throw new Error('Levee returned an unexpected webhook endpoint list');
  const endpoints: ListedEndpoint[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || entry.disabled_at != null) continue;
    const id = asString(entry.id);
    const url = asString(entry.url);
    if (id === null || url === null) continue;
    const events = Array.isArray(entry.events) ? entry.events.filter((item) => typeof item === 'string') : [];
    endpoints.push({ id, url, events });
  }
  return endpoints;
}

function sameEvents(events: readonly string[]): boolean {
  return events.length === WEBHOOK_EVENT_TYPES.length && WEBHOOK_EVENT_TYPES.every((type) => events.includes(type));
}

function isQuickTunnel(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith('.trycloudflare.com');
  } catch {
    return false;
  }
}

/**
 * Makes sure Levee delivers this platform's events to `url`, signed with a secret Acme holds.
 *
 * Levee's platform webhook endpoints cannot be updated or deleted, and their signing secret is
 * returned only when one is registered. So the saved endpoint is reused when it is still active
 * with the same URL and events, and otherwise a new one is registered. A restart on the same URL
 * therefore adds nothing; a new URL adds one endpoint.
 */
export async function ensureWebhookEndpoint(
  api: WebhookEndpointApi,
  platformId: string,
  url: string,
  saved: RegisteredWebhookEndpoint | null,
): Promise<EnsureWebhookEndpointResult> {
  const path = `/v1/platforms/${encodeURIComponent(platformId)}/webhook-endpoints`;
  const active = listed(await api.get<unknown>(path));
  const stale = (keepId: string) =>
    active.filter((endpoint) => endpoint.id !== keepId && isQuickTunnel(endpoint.url)).length;

  const current = saved === null ? undefined : active.find((endpoint) => endpoint.id === saved.id);
  if (
    saved !== null &&
    current !== undefined &&
    current.url === url &&
    saved.url === url &&
    sameEvents(current.events)
  ) {
    return { endpoint: saved, registered: false, staleTunnelEndpoints: stale(saved.id) };
  }

  const created = await api.post<unknown>(path, { url, events: [...WEBHOOK_EVENT_TYPES] });
  const id = isRecord(created) ? asString(created.id) : null;
  const secret = isRecord(created) ? asString(created.secret) : null;
  if (id === null || secret === null || !secret.startsWith('whsec_')) {
    throw new Error('Levee did not return the new webhook endpoint and its signing secret');
  }
  const registeredUrl = isRecord(created) ? (asString(created.url) ?? url) : url;
  return { endpoint: { id, url: registeredUrl, secret }, registered: true, staleTunnelEndpoints: stale(id) };
}

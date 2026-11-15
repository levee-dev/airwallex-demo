import type { AppContext } from '../context';
import type { WebhookEnvelope } from '../db/schema';
import { verifyWebhookSignature } from '../levee/webhook-signature';
import { asString, isRecord } from '../lib/values';
import { MAX_PENDING_EVENTS, pendingEventCount, recordEvent } from './events';
import { processEvent } from './replay';

export const MAX_WEBHOOK_BYTES = 256 * 1024;

export interface WebhookReceipt {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

function envelopeOf(raw: string): WebhookEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.data)) return null;
  const eventId = asString(parsed.event_id);
  const type = asString(parsed.type);
  const createdAt = asString(parsed.created_at);
  const tenantId = asString(parsed.tenant_id);
  if (eventId === null || type === null || createdAt === null || tenantId === null) return null;
  return { event_id: eventId, type, created_at: createdAt, tenant_id: tenantId, data: parsed.data };
}

/**
 * Levee's webhook receiver. In order: size cap, HMAC signature over the raw bytes within a
 * five-minute window (with the setup secret or the dev tunnel endpoint's), envelope shape and
 * tenant, then de-duplication by event id. Only then is the event applied. Events that arrive
 * before Acme's own record are kept and replayed later.
 */
export async function receiveWebhook(
  ctx: AppContext,
  raw: string,
  headers: { readonly signature: string | undefined; readonly eventId: string | undefined },
): Promise<WebhookReceipt> {
  if (Buffer.byteLength(raw) > MAX_WEBHOOK_BYTES) return { status: 413, body: { error: 'too_large' } };
  const signature = headers.signature;
  if (signature === undefined) return { status: 401, body: { error: 'signature_required' } };
  const credentials = await ctx.platform.credentials();
  const nowMs = ctx.now().getTime();
  const verified = credentials.webhookSecrets.some((secret) =>
    verifyWebhookSignature({ secret, header: signature, body: raw, nowMs }),
  );
  if (!verified) return { status: 401, body: { error: 'invalid_signature' } };
  const envelope = envelopeOf(raw);
  if (envelope === null) return { status: 400, body: { error: 'invalid_envelope' } };
  if (envelope.tenant_id !== credentials.leveeTenantId) return { status: 403, body: { error: 'tenant_mismatch' } };
  if (headers.eventId !== undefined && headers.eventId !== envelope.event_id) {
    return { status: 400, body: { error: 'event_id_mismatch' } };
  }
  await ctx.platform.recordWebhook(ctx.now());
  if ((await pendingEventCount(ctx)) >= MAX_PENDING_EVENTS)
    return { status: 503, body: { error: 'pending_event_capacity' } };
  if (!(await recordEvent(ctx, envelope))) {
    const retried = await processEvent(ctx, envelope);
    return { status: 200, body: { duplicate: true, ...(retried === null ? {} : { result: retried }) } };
  }
  const result = await processEvent(ctx, envelope);
  return result === 'applied'
    ? { status: 200, body: { ok: true } }
    : { status: 202, body: { result: result ?? 'in_progress' } };
}

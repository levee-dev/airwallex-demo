import { createHmac, timingSafeEqual } from 'node:crypto';

/** Deliveries signed more than this far from now are refused as replays. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

const TIMESTAMP = /^[0-9]{1,12}$/;
const SIGNATURE = /^[0-9a-f]{64}$/;

/** HMAC-SHA256(secret, `${timestamp}.${body}`) as lowercase hex. */
export function signWebhookPayload(secret: string, timestamp: number | string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex');
}

/** The `Levee-Signature` header value for a body, as Levee sends it. */
export function webhookSignatureHeader(secret: string, timestamp: number, body: string): string {
  return `t=${timestamp},v1=${signWebhookPayload(secret, timestamp, body)}`;
}

/**
 * Verifies `Levee-Signature: t=<unix seconds>,v1=<hex>` over the raw body, in constant time.
 * Malformed, duplicated or unknown header parts fail closed.
 */
export function verifyWebhookSignature(input: {
  readonly secret: string;
  readonly header: string;
  readonly body: string;
  readonly nowMs: number;
}): boolean {
  let timestamp: string | null = null;
  let signature: string | null = null;
  for (const raw of input.header.split(',')) {
    const part = raw.trim();
    const separator = part.indexOf('=');
    if (separator <= 0) return false;
    const key = part.slice(0, separator);
    const value = part.slice(separator + 1);
    if (key === 't' && timestamp === null && TIMESTAMP.test(value)) timestamp = value;
    else if (key === 'v1' && signature === null && SIGNATURE.test(value)) signature = value;
    else return false;
  }
  if (timestamp === null || signature === null || input.secret.length === 0) return false;
  if (Math.abs(Math.floor(input.nowMs / 1000) - Number(timestamp)) > WEBHOOK_TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(signWebhookPayload(input.secret, timestamp, input.body), 'hex');
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

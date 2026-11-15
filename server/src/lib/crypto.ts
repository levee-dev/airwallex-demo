import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const ENVELOPE_VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Parses ACME_ENCRYPTION_KEY: exactly 32 bytes in canonical base64. Non-canonical input is refused so
 * a typo can never silently decode to a different key.
 */
export function parseEncryptionKey(raw: string | undefined): Buffer {
  const trimmed = raw?.trim() ?? '';
  if (trimmed.length === 0) throw new Error('ACME_ENCRYPTION_KEY is required');
  const key = Buffer.from(trimmed, 'base64');
  if (key.length !== 32 || key.toString('base64') !== trimmed) {
    throw new Error('ACME_ENCRYPTION_KEY must be 32 bytes encoded as base64');
  }
  return key;
}

/** AES-256-GCM. The envelope is `v1.<iv>.<tag>.<ciphertext>`, each part base64url. */
export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const parts = [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url'));
  return [ENVELOPE_VERSION, ...parts].join('.');
}

export function decryptSecret(envelope: string, key: Buffer): string {
  const [version, ivText, tagText, ciphertextText, ...extra] = envelope.split('.');
  if (version !== ENVELOPE_VERSION || extra.length > 0 || !ivText || !tagText || ciphertextText === undefined) {
    throw new Error('stored secret is not a supported ciphertext');
  }
  const iv = Buffer.from(ivText, 'base64url');
  const tag = Buffer.from(tagText, 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('stored secret has an invalid envelope');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(ciphertextText, 'base64url')), decipher.final()]).toString('utf8');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** A random bearer value: `prefix` followed by `bytes` random bytes in base64url. */
export function randomToken(prefix: string, bytes = 32): string {
  return `${prefix}${randomBytes(bytes).toString('base64url')}`;
}

export function newId(prefix: string): string {
  return randomToken(`${prefix}_`, 12);
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The last four characters of a secret, the only part ever displayed. */
export function last4(secret: string): string {
  return secret.slice(-4);
}

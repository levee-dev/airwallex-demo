import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, parseEncryptionKey, safeEqual } from '../../src/lib/crypto';
import { hashPassword, normalizeEmail, verifyPassword } from '../../src/lib/passwords';

describe('secret encryption', () => {
  const key = randomBytes(32);

  it('round-trips and never stores the plaintext', () => {
    const envelope = encryptSecret('sk_test_secret_value', key);
    expect(envelope).not.toContain('sk_test');
    expect(envelope.split('.')).toHaveLength(4);
    expect(decryptSecret(envelope, key)).toBe('sk_test_secret_value');
  });

  it('uses a fresh IV every time', () => {
    expect(encryptSecret('same', key)).not.toBe(encryptSecret('same', key));
  });

  it('refuses a tampered envelope or the wrong key', () => {
    const envelope = encryptSecret('value', key);
    const parts = envelope.split('.');
    const tampered = [...parts.slice(0, 3), Buffer.from('other').toString('base64url')].join('.');
    expect(() => decryptSecret(tampered, key)).toThrow();
    expect(() => decryptSecret(envelope, randomBytes(32))).toThrow();
    expect(() => decryptSecret('v2.a.b.c', key)).toThrow(/supported/);
  });

  it('accepts only a canonical 32-byte base64 key', () => {
    const raw = randomBytes(32).toString('base64');
    expect(parseEncryptionKey(raw)).toHaveLength(32);
    expect(() => parseEncryptionKey(undefined)).toThrow(/required/);
    expect(() => parseEncryptionKey(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
    expect(() => parseEncryptionKey(`${raw.slice(0, -2)}!=`)).toThrow(/32 bytes/);
  });

  it('compares in constant time without throwing on length mismatch', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('password hashing', () => {
  it('verifies the right password and rejects others', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('wrong horse battery', hash)).toBe(false);
  });

  it('salts every hash', async () => {
    expect(await hashPassword('same password here')).not.toBe(await hashPassword('same password here'));
  });

  it('fails closed for a missing or malformed hash', async () => {
    expect(await verifyPassword('anything', null)).toBe(false);
    expect(await verifyPassword('anything', 'scrypt$bad')).toBe(false);
  });

  it('normalizes emails for lookup', () => {
    expect(normalizeEmail('  Pat@Example.COM ')).toBe('pat@example.com');
  });
});

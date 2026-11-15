import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Salted scrypt password hashes, encoded `scrypt$N$r$p$salt$hash`. Verification does the same work
 * for an unknown account as for a wrong password, so timing does not reveal which emails exist.
 */

const COST = { N: 16_384, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;
const DUMMY_SALT = Buffer.alloc(SALT_BYTES, 0x41);
const DUMMY_HASH = Buffer.alloc(KEY_LENGTH, 0x1f);

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

interface Cost {
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

function derive(password: string, salt: Buffer, cost: Cost): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, { ...cost, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

function parse(encoded: string): { cost: Cost; salt: Buffer; hash: Buffer } | null {
  const [scheme, n, r, p, salt, hash, ...extra] = encoded.split('$');
  if (scheme !== 'scrypt' || extra.length > 0 || salt === undefined || hash === undefined) return null;
  const cost = { N: Number(n), r: Number(r), p: Number(p) };
  if (![cost.N, cost.r, cost.p].every((value) => Number.isSafeInteger(value) && value > 0) || cost.N < 2) return null;
  const saltBytes = Buffer.from(salt, 'base64');
  const hashBytes = Buffer.from(hash, 'base64');
  if (saltBytes.length === 0 || hashBytes.length !== KEY_LENGTH) return null;
  return { cost, salt: saltBytes, hash: hashBytes };
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(password, salt, COST);
  return `scrypt$${COST.N}$${COST.r}$${COST.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, encoded: string | null): Promise<boolean> {
  const parsed = encoded === null ? null : parse(encoded);
  const expected = parsed?.hash ?? DUMMY_HASH;
  let derived: Buffer;
  try {
    derived = await derive(password, parsed?.salt ?? DUMMY_SALT, parsed?.cost ?? COST);
  } catch {
    return false;
  }
  return timingSafeEqual(derived, expected) && parsed !== null;
}

/** The one form used for uniqueness and lookup. */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidEmail(normalized: string): boolean {
  return normalized.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized);
}

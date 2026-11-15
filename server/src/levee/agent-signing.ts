import { createHash, createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';

/**
 * An agent signs every purchase declaration with its own Ed25519 key; Levee verifies it against the
 * public key registered for the agent. The signature is a compact JWS (`alg: EdDSA`) whose payload
 * is the 32-byte SHA-256 digest of the declaration in RFC 8785 (JCS) canonical JSON.
 */

export interface AgentKeyPair {
  /** PKCS#8 DER, base64. Stored encrypted; never leaves the server. */
  readonly privateKeyPkcs8: string;
  readonly publicKeyJwk: { readonly kty: 'OKP'; readonly crv: 'Ed25519'; readonly x: string };
}

export function generateAgentKey(): AgentKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  if (typeof jwk.x !== 'string') throw new Error('generated key is not Ed25519');
  return {
    privateKeyPkcs8: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: jwk.x },
  };
}

/**
 * RFC 8785 canonical JSON for the values a declaration holds: strings, safe integers, booleans,
 * null, arrays and objects. Floats and unsafe integers are refused rather than reformatted.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new Error('only safe integers can be signed');
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== undefined);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  throw new Error(`cannot sign a ${typeof value}`);
}

/** Compact JWS over the SHA-256 digest of the canonical payload. */
export function signPayload(payload: unknown, privateKeyPkcs8: string, kid: string): string {
  const digest = createHash('sha256').update(canonicalJson(payload), 'utf8').digest();
  const header = Buffer.from(canonicalJson({ alg: 'EdDSA', kid })).toString('base64url');
  const signingInput = `${header}.${digest.toString('base64url')}`;
  const key = createPrivateKey({ key: Buffer.from(privateKeyPkcs8, 'base64'), format: 'der', type: 'pkcs8' });
  return `${signingInput}.${sign(null, Buffer.from(signingInput), key).toString('base64url')}`;
}

import { createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson, generateAgentKey, signPayload } from '../../src/levee/agent-signing';

describe('canonical JSON (RFC 8785)', () => {
  it('sorts keys by UTF-16 code units and drops whitespace', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x'] })).toBe('{"a":[true,null,"x"],"b":1}');
    expect(canonicalJson({ '\u{FF61}': 2, '\u{1F600}': 1 })).toBe('{"\u{1F600}":1,"\u{FF61}":2}');
  });

  it('refuses values that cannot be signed exactly', () => {
    expect(() => canonicalJson({ amount: 1.5 })).toThrow(/safe integers/);
    expect(() => canonicalJson({ amount: 2 ** 53 })).toThrow(/safe integers/);
  });
});

describe('declaration signatures', () => {
  it('produce a compact EdDSA JWS over the payload digest that verifies with the agent public key', () => {
    const key = generateAgentKey();
    const jws = signPayload({ amount: { currency: 'USD', value: 2500 } }, key.privateKeyPkcs8, 'acme/agent_test_1');
    const [header, payload, signature] = jws.split('.');
    expect(JSON.parse(Buffer.from(header ?? '', 'base64url').toString())).toEqual({
      alg: 'EdDSA',
      kid: 'acme/agent_test_1',
    });
    expect(Buffer.from(payload ?? '', 'base64url')).toHaveLength(32);
    const publicKey = createPublicKey({ key: { ...key.publicKeyJwk }, format: 'jwk' });
    expect(
      verify(null, Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature ?? '', 'base64url')),
    ).toBe(true);
  });
});

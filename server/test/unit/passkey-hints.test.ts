import { describe, expect, it } from 'vitest';
import { withHybridHint } from '../../../web/src/lib/passkey-hints';

describe('"Use my phone" passkey hints', () => {
  const options = {
    challenge: 'Y2hhbGxlbmdl',
    rp: { id: 'pay.example.com', name: 'Acme Pay' },
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  };

  it('adds the hybrid hint and leaves everything Levee sent as it was', () => {
    const hinted = withHybridHint(options);
    expect(hinted).toEqual({ ...options, hints: ['hybrid'] });
    expect(options).not.toHaveProperty('hints');
  });

  it('puts hybrid first without duplicating it', () => {
    expect(withHybridHint({ ...options, hints: ['security-key', 'hybrid'] }).hints).toEqual(['hybrid', 'security-key']);
  });

  it('drops a platform-only attachment, which would rule the phone out', () => {
    const hinted = withHybridHint({
      ...options,
      authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'required' },
    });
    expect(hinted.authenticatorSelection).toEqual({ residentKey: 'required' });
  });
});

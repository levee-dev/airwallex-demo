/**
 * WebAuthn Level 3 `hints`: `hybrid` asks the browser to lead with "use a phone or tablet", so Chrome
 * shows the QR code for a phone straight away. The options come from Levee; hints are not part of
 * what it signs or verifies, so adding one client-side changes nothing on the server. Browsers that
 * do not know hints (Safari today) ignore the field and still offer a phone in their own sheet.
 *
 * Kept free of DOM types so the server's test suite can exercise it.
 */

interface CreationOptions {
  readonly hints?: readonly string[];
  readonly authenticatorSelection?: {
    readonly authenticatorAttachment?: string;
    readonly residentKey?: string;
    readonly requireResidentKey?: boolean;
    readonly userVerification?: string;
  };
}

/** The same registration options, asking for the phone (hybrid) flow first. */
export function withHybridHint<T extends CreationOptions>(options: T): T {
  const hints = ['hybrid', ...(options.hints ?? []).filter((hint) => hint !== 'hybrid')];
  const selection = options.authenticatorSelection;
  // A platform-only attachment would rule the phone out, and it outranks hints; drop just that.
  if (selection?.authenticatorAttachment === 'platform') {
    const rest = Object.fromEntries(Object.entries(selection).filter(([key]) => key !== 'authenticatorAttachment'));
    return { ...options, hints, authenticatorSelection: rest };
  }
  return { ...options, hints };
}

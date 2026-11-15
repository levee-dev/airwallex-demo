/** The parts of Levee's public API responses that Acme reads. */

export interface LeveeApprovalCardRow {
  readonly field: string;
  readonly label: string;
  readonly value: string;
  readonly source: 'user' | 'inferred' | 'policy';
}

export interface LeveeApprovalCard {
  readonly title: string;
  readonly summary: string;
  readonly agent: { readonly id: string; readonly name: string };
  readonly rows: readonly LeveeApprovalCardRow[];
  readonly warnings: readonly string[];
}

interface MoneyBound {
  readonly currency: string;
  readonly max?: number;
  readonly min?: number;
}

/** `POST /v1/mandates` and `POST /v1/challenges/{id}/extend`. */
export interface LeveeCreatedMandate {
  readonly id: string;
  readonly version: number;
  readonly state: string;
  readonly approval_expires_at: string;
  readonly approval_card: LeveeApprovalCard;
  readonly adjustments: readonly { field: string; previous: MoneyBound; effective: MoneyBound }[];
  readonly warnings: readonly { code?: string; field?: string; message?: string }[];
  readonly mandate: Record<string, unknown>;
}

/** `GET /v1/mandates/{id}` or `{id}@{version}`. */
export interface LeveeMandateView {
  readonly id: string;
  readonly version: number;
  readonly state: string;
  readonly card_id: string | null;
  readonly card_last4: string | null;
  readonly remaining_minor: number | null;
  readonly spent_minor: number;
  readonly freeze_status: string | null;
  readonly constraints: {
    readonly budget: { readonly currency: string; readonly max: number };
    readonly amount_per_txn?: { readonly currency: string; readonly max: number };
  };
}

/** `GET /v1/challenges/{id}` and the entries of `GET /v1/challenges?status=PENDING`. */
export interface LeveeChallenge {
  readonly id: string;
  readonly mandateId: string;
  readonly mandateVersion: number;
  readonly amountMinor: number;
  readonly currency: string;
  readonly status: 'PENDING' | 'APPROVED' | 'DENIED' | 'EXPIRED';
  readonly createdAt: string;
  readonly expiresAt: string;
}

/** `POST /v1/declarations`. */
export interface LeveeDeclarationResult {
  readonly declaration: { readonly id: string } | null;
  readonly predicted: {
    readonly outcome: 'approve' | 'challenge' | 'decline';
    readonly reason_codes: readonly string[];
    readonly challenge_id?: string;
    /** A first purchase from a shop Levee has no verified identity for; the person confirms it. */
    readonly learning?: true;
  };
}

/** `POST /v1/agents/{id}/purchase`: a sandbox card swipe decided by Levee over Remote Authorization. */
export interface LeveePurchaseResult {
  readonly issuer?: string;
  /**
   * AUTHORIZED only when the issuer authorized; FAILED when the issuer refused a swipe Levee
   * approved; UNCONFIRMED when the issuer's result is not known yet; DECLINED for a Levee decline or
   * challenge.
   */
  readonly response_status: 'AUTHORIZED' | 'DECLINED' | 'FAILED' | 'UNCONFIRMED';
  readonly status_reason: string;
  readonly issuer_failure_reason?: string | null;
  readonly card_transaction_event_id?: string;
  readonly challenge_id: string | null;
  readonly decision: null | {
    readonly outcome: string;
    readonly reasonCode: string;
    readonly reasons?: readonly string[];
  };
}

/** One entry of `GET /v1/decisions`, after validation. */
export interface LeveeDecisionRecord {
  readonly eventId: string;
  readonly cardId: string | null;
  readonly mandateId: string | null;
  readonly outcome: 'APPROVE' | 'DECLINE' | 'CHALLENGE';
  readonly amountMinor: number;
  readonly currency: string;
  readonly merchantName: string | null;
  readonly mcc: string | null;
  readonly reasonCode: string;
  readonly reasons: readonly string[];
  readonly statusReason: string;
  readonly challengeId: string | null;
  readonly createdAtMs: number;
  readonly latencyMs: number | null;
  readonly issuerOutcome: 'AUTHORIZED' | 'FAILED' | 'REVERSED' | null;
  readonly issuerFailureReason: string | null;
}

/** `GET /v1/platforms/{id}/tenants` entries. */
export interface LeveeTenant {
  readonly id: string;
  readonly environment?: string;
  readonly program_type?: string;
  readonly display_name?: string;
  readonly webauthn?: { readonly rpId?: string; readonly origins?: readonly string[] };
}

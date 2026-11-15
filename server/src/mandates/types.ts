/** The signed terms in plain values, captured when the mandate is created. */
export interface MandateTerms {
  readonly currency: string;
  readonly totalMinor: number;
  /** Null when the person stated no separate per-payment limit. */
  readonly perPurchaseCapMinor: number | null;
  readonly validUntil: string;
  readonly categories: readonly string[];
  readonly purpose: string;
}

export type FieldSource = 'user' | 'inferred' | 'policy';

export interface ApprovalItem {
  readonly field: string;
  readonly label: string;
  readonly value: string;
  readonly source: FieldSource;
}

/** What Acme's optional decision model concluded about a mandate request. Preview metadata only. */
export type AutomatedChecks =
  | {
      readonly status: 'passed';
      readonly model: string;
      readonly purposeMatch: number;
      readonly injection: number;
      readonly category: string;
    }
  | { readonly status: 'unavailable' };

/** The approval preview the person reads before signing with their passkey. */
export interface ApprovalView {
  readonly reference: string;
  readonly title: string;
  readonly summary: string;
  readonly agentName: string;
  readonly youSaid: readonly ApprovalItem[];
  readonly weFilledIn: readonly ApprovalItem[];
  readonly adjustments: readonly { readonly label: string; readonly from: string; readonly to: string }[];
  readonly warnings: readonly string[];
  readonly notes: readonly string[];
  readonly riskNotes: readonly string[];
  readonly automatedChecks: AutomatedChecks;
  readonly approvalExpiresAt: string;
}

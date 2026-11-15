/** Response shapes of the Acme Pay server, as the web app reads them. */

/** The person's card account, opened in the background after sign-up. */
export interface Account {
  readonly status: 'opening' | 'ready' | 'failed';
  readonly connectedAccountStatus: string | null;
  readonly approverReady: boolean;
  readonly error: string | null;
}

export interface User {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly hasPasskey: boolean;
  /** At least one browser gets approval notifications. */
  readonly phoneNotifications: boolean;
  readonly account: Account;
}

export interface SessionResponse {
  readonly csrfToken: string;
  readonly user: User;
}

export interface Agent {
  readonly id: string;
  readonly name: string;
  readonly client: string;
  readonly tokenLast4: string | null;
  readonly lastCallAt: string | null;
}

export interface AgentList {
  readonly mcpUrl: string;
  readonly agents: readonly Agent[];
}

export interface AgentToken {
  readonly agent: Agent;
  readonly token: string;
  readonly mcpUrl: string;
}

export interface MandateSummary {
  readonly id: string;
  readonly agentId: string;
  readonly purpose: string;
  readonly status: 'active' | 'paused' | 'pending' | 'ended';
  readonly pendingAction: string | null;
  readonly currency: string;
  readonly totalMinor: number;
  readonly spentMinor: number;
  readonly remainingMinor: number;
  readonly validUntil: string;
  readonly categories: readonly string[];
  readonly cardLast4: string | null;
  readonly freezeStatus: 'none' | 'requested' | 'frozen' | 'failed';
}

export interface Dashboard {
  readonly agents: readonly Agent[];
  readonly mandates: readonly MandateSummary[];
  readonly approvals: readonly { id: string; kind: string; title: string; url: string; expiresAt: string }[];
  readonly purchases: readonly {
    id: string;
    merchantName: string;
    item: string;
    amountMinor: number;
    currency: string;
    outcome: 'approved' | 'failed' | 'unconfirmed' | 'declined' | 'needs_approval';
    reasons: readonly string[];
    decisionLatencyMs: number | null;
    createdAt: string;
  }[];
  readonly inbox: readonly { id: string; title: string; body: string; read: boolean; createdAt: string }[];
}

export interface ApprovalItem {
  readonly field: string;
  readonly label: string;
  readonly value: string;
}

export type ApprovalAction = 'approve' | 'decline' | 'allow-once' | 'allow-from-now-on' | 'deny';

export interface ApprovalPage {
  readonly kind: 'mandate' | 'step_up' | 'resume';
  readonly title: string;
  readonly shortTitle: string;
  readonly expiresAt: string;
  readonly agent: { readonly name: string; readonly client: string };
  readonly approverHint: string;
  readonly intentQuote: string | null;
  readonly merchant: { readonly name: string; readonly category: string | null } | null;
  readonly amount: { readonly minor: number; readonly currency: string } | null;
  readonly budget: {
    readonly currency: string;
    readonly totalMinor: number;
    readonly remainingMinor: number;
    readonly perPurchaseCapMinor: number | null;
    readonly validUntil: string;
    readonly categories: readonly string[];
  };
  readonly overByMinor: number | null;
  readonly preview: {
    readonly youSaid: readonly ApprovalItem[];
    readonly weFilledIn: readonly ApprovalItem[];
    readonly warnings: readonly string[];
    readonly notes: readonly string[];
    readonly riskNotes: readonly string[];
  } | null;
  readonly firstPurchase: {
    readonly declared: {
      readonly name: string;
      readonly domain: string;
      readonly amountMinor: number;
      readonly currency: string;
    };
    readonly observed: {
      readonly descriptor: string;
      readonly mcc: string;
      readonly category: string;
      readonly country: string;
    };
  } | null;
  readonly allowedActions: readonly ApprovalAction[];
}

export interface PushDevice {
  readonly id: string;
  readonly label: string;
  readonly createdAt: string;
}

/** `GET /api/push`: what the phone step needs. `publicUrl` is the app's public origin from the server. */
export interface PushInfo {
  readonly configured: boolean;
  readonly publicKey: string | null;
  readonly publicUrl: string;
  readonly devices: readonly PushDevice[];
}

/** Levee reason codes in plain words. Raw codes never reach the person or the agent. */
const LEVEE_REASONS: Readonly<Record<string, string>> = {
  OK_WITHIN_MANDATE: 'Within what you approved.',
  DECLARATION_MATCHED: "The purchase matched the agent's declared purchase.",
  ENGINE_ERROR_FAIL_CLOSED: 'This purchase could not be checked safely, so it was declined.',
  ENGINE_DEADLINE_FAIL_CLOSED: 'The safety check timed out, so this purchase was declined.',
  KILL_SWITCH: 'All agent spending is switched off.',
  CARD_NOT_BOUND: 'This card is not linked to an approved agent.',
  AGENT_SUSPENDED: 'This agent is suspended.',
  AGENT_NOT_MANDATED: "This agent's identity does not match the approval requirements.",
  POLICY_MCC_DENIED: 'This kind of shop is not allowed.',
  POLICY_COUNTRY_DENIED: 'Purchases from this country are not allowed.',
  VELOCITY_EXCEEDED: 'Too many purchases in a short time.',
  NO_ACTIVE_MANDATE: 'The agent is paused or has no active approval.',
  MANDATE_REVOKED: 'You revoked this agent.',
  MANDATE_EXPIRED: 'The approval has ended.',
  MANDATE_NOT_YET_VALID: 'The approval has not started yet.',
  MANDATE_EXHAUSTED: 'The agent has used up the approved budget or number of purchases.',
  MERCHANT_NOT_ALLOWED: 'This shop is not one you approved.',
  MCC_NOT_ALLOWED: 'This kind of shop is not one you approved.',
  CURRENCY_NOT_ALLOWED: 'This currency is not one you approved.',
  COUNTRY_NOT_ALLOWED: 'This country is not one you approved.',
  CARD_PRESENT_NOT_ALLOWED: 'Only online purchases are allowed.',
  AMOUNT_OVER_TXN_CAP: 'More than the per-payment limit you approved.',
  NETWORK_INTENT_VIOLATED: 'The card network intent did not match.',
  BUDGET_EXCEEDED: 'This would go over the budget you approved.',
  RESERVE_FLOOR_BREACHED: 'This would take the account below its reserve.',
  UNDECLARED_SPEND: 'The agent did not declare this purchase first.',
  DECLARATION_INVALID: "The agent's description of this purchase could not be verified.",
  DECLARATION_REUSED: 'The agent reused an earlier purchase description.',
  DECLARATION_EXPIRED: "The agent's purchase description expired.",
  DECLARATION_PAYEE_MISMATCH: 'The shop charging the card is not the one the agent described.',
  DECLARATION_AMOUNT_OVER: 'The charge is higher than the agent said.',
  RISK_SCORE_HIGH: 'This purchase looked risky.',
  MODEL_TIGHTEN_CHALLENGE: 'An additional risk check requires your approval.',
  MODEL_TIGHTEN_DECLINE: 'An additional risk check declined this purchase.',
  EXPLORATION_CHALLENGE: 'This purchase was selected for review.',
  MODEL_SKIPPED: 'Spending rules and declaration checks decided this purchase.',
  FAIL_OPEN_APPLIED: 'A configured fallback allowed this purchase while normal checks were unavailable.',
  CHALLENGE_RATE_LIMITED: 'Too many approval requests this hour.',
  CHALLENGE_REJECTED: 'You said no to this purchase.',
  CHALLENGE_EXPIRED: 'Your approval request for this purchase expired.',
  CHALLENGE_AMOUNT_OVER_MANDATE: 'A little over your limit, so it needs your OK.',
  CHALLENGE_NEW_MERCHANT: 'A shop you have not approved yet, so it needs your OK.',
  CHALLENGE_RISK: 'This purchase needs your OK.',
  CHALLENGE_GRANT_USED: 'Allowed once with your OK.',
};

/** Acme's own codes for what happened after Levee approved. They are never sent to Levee. */
const ACME_REASONS: Readonly<Record<string, string>> = {
  ISSUER_INSUFFICIENT_FUNDS:
    "The card account doesn't have enough funds; nothing was charged. Add funds before trying again.",
  ISSUER_DECLINED: 'The card issuer declined this payment. Nothing was charged.',
  ISSUER_REVERSED: 'The card issuer reversed this payment; it is not charged.',
  ISSUER_UNCONFIRMED:
    'The card issuer has not confirmed this payment yet, so its final status is unknown. Do not retry it; check its status first.',
  FIRST_PURCHASE_NOT_SENT:
    'This first purchase from the shop could not be sent for your approval: what the card network sent did not match what the agent described. Nothing was charged.',
  FIRST_PURCHASE: 'First purchase from this shop, needs your approval.',
};

export function plainReason(code: string): string {
  return ACME_REASONS[code] ?? LEVEE_REASONS[code.replace(/^LEVEE_/, '')] ?? 'The payment was not approved.';
}

/** Acme's code for an issuer failure after Levee approved. */
export function issuerFailureCode(reason: string | null | undefined): string {
  return reason === 'INSUFFICIENT_FUNDS' || reason === 'INSUFFICIENT_AVAILABLE_CREDIT'
    ? 'ISSUER_INSUFFICIENT_FUNDS'
    : 'ISSUER_DECLINED';
}

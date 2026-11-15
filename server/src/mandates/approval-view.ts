import type { LeveeCreatedMandate } from '../levee/types';
import { formatMoney } from '../lib/money';
import { asRecord } from '../lib/values';
import type { ApprovalItem, ApprovalView, AutomatedChecks, FieldSource } from './types';

export const FIELD_LABELS: Readonly<Record<string, string>> = {
  purpose: 'Purpose',
  mode: 'How the agent pays',
  'constraints.budget': 'Total',
  'constraints.budget.max': 'Amount you specified',
  'constraints.amount_per_txn': 'Per payment',
  'constraints.step_up_cap': 'Over-budget headroom',
  'constraints.merchants': 'Stores',
  'constraints.mcc': 'Category',
  'constraints.currencies': 'Currency',
  'constraints.window': 'Until',
  'constraints.card_not_present_only': 'Card use',
  'out_of_mandate.action': 'Outside these terms',
  'out_of_mandate.challenge_if': 'Exceptions',
  'out_of_mandate.max_challenges_per_hour': 'Requests per hour',
};

const WARNINGS: Readonly<Record<string, string>> = {
  MCC_ONLY_SCOPE: 'Any merchant in the allowed categories may qualify; individual stores are not restricted.',
  WINDOW_OVER_90_DAYS: 'These spending terms last longer than 90 days.',
  RECURRENCE_NO_END: 'These recurring spending terms have no end date.',
};

function pick(body: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => asRecord(value)[key], body);
}

/** A readable value for a drafted field that Levee's card has no row for. */
export function describeField(field: string, body: Record<string, unknown>): string {
  const value = pick(body, field);
  switch (field) {
    case 'mode':
      return value === 'autonomous' ? 'On its own, within these terms' : 'With you present';
    case 'constraints.budget.max':
      return typeof value === 'number' ? formatMoney(value, 'USD') : '';
    case 'constraints.merchants': {
      const allow = pick(body, 'constraints.merchants.allow');
      return Array.isArray(allow) ? allow.map((entry) => String(asRecord(entry).name)).join(', ') : 'Any store';
    }
    case 'out_of_mandate.action':
      return value === 'challenge' ? 'Ask you first' : 'Decline';
    case 'out_of_mandate.max_challenges_per_hour':
      return `Up to ${String(value)} an hour`;
    default:
      return typeof value === 'string' ? value : JSON.stringify(value);
  }
}

function covers(rowField: string, field: string): boolean {
  return rowField === field || rowField.startsWith(`${field}.`) || field.startsWith(`${rowField}.`);
}

function boundText(bound: { currency: string; max?: number; min?: number }): string {
  return formatMoney(bound.max ?? bound.min ?? 0, bound.currency);
}

/**
 * The preview the person signs. Levee's card rows keep their signed provenance; a field Acme filled
 * in that Levee shows no row for is still listed under "We filled in", so nothing the person did
 * not say is hidden.
 */
export function buildApprovalView(input: {
  readonly created: LeveeCreatedMandate;
  readonly fields: Readonly<Record<string, FieldSource>>;
  readonly notes: readonly string[];
  readonly riskNotes: readonly string[];
  readonly checks: AutomatedChecks;
}): ApprovalView {
  const { created } = input;
  const card = created.approval_card;
  const youSaid: ApprovalItem[] = [];
  const filledIn: ApprovalItem[] = [];
  for (const row of card.rows) {
    const drafted = Object.entries(input.fields).find(([field]) => covers(row.field, field))?.[1];
    const source = row.source === 'user' && drafted !== undefined && drafted !== 'user' ? drafted : row.source;
    (source === 'user' ? youSaid : filledIn).push({ field: row.field, label: row.label, value: row.value, source });
  }
  for (const [field, source] of Object.entries(input.fields)) {
    const listed = [...youSaid, ...filledIn].find((item) => covers(item.field, field));
    if (source === 'user') {
      if (!youSaid.some((item) => item.field === field)) {
        youSaid.push({
          field,
          label: FIELD_LABELS[field] ?? field,
          value: describeField(field, created.mandate),
          source,
        });
      }
    } else if (!filledIn.some((item) => item.field === field)) {
      filledIn.push({
        field,
        label: listed?.label ?? FIELD_LABELS[field] ?? field,
        value: listed?.value ?? describeField(field, created.mandate),
        source,
      });
    }
  }
  const warnings = [
    ...card.warnings.map((code) => WARNINGS[code] ?? code),
    ...created.warnings.map((warning) => warning.message ?? WARNINGS[warning.code ?? ''] ?? 'Policy warning'),
  ];
  return {
    reference: `${created.id}@${created.version}`,
    title: card.title,
    summary: card.summary,
    agentName: card.agent.name,
    youSaid,
    weFilledIn: filledIn,
    adjustments: created.adjustments.map((adjustment) => ({
      label: FIELD_LABELS[adjustment.field] ?? adjustment.field,
      from: boundText(adjustment.previous),
      to: boundText(adjustment.effective),
    })),
    warnings: [...new Set(warnings)],
    notes: [...input.notes],
    riskNotes: [...input.riskNotes],
    automatedChecks: input.checks,
    approvalExpiresAt: created.approval_expires_at,
  };
}

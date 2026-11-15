import { MAX_AMOUNT_MINOR, formatMoney } from '../lib/money';
import { categoryByKey, type MerchantCategory } from '../merchants/catalog';
import { findKnownMerchant, hostOf, resolveMerchant } from '../merchants/resolver';
import type { FieldSource } from './types';

/**
 * Builds a Levee mandate draft from the typed fields an agent filled in, in code and with no text
 * parsing: categories map to MCCs, named merchants resolve to exact descriptor patterns, and the
 * window is computed from the clock. Anything missing or conflicting is a question for the agent.
 */

export const MAX_WINDOW_DAYS = 31;
const DAY_MS = 86_400_000;

/** A mandate request, already shape-checked. */
export interface MandateRequest {
  readonly capMinor: number;
  readonly categories: readonly string[];
  readonly merchants?: readonly { readonly name: string; readonly url?: string }[];
  readonly window: { readonly days: number } | { readonly until: string };
  /** The person's own words, shown on the approval page. */
  readonly purpose: string;
}

interface AllowedMerchant {
  readonly name: string;
  readonly domain: string;
  readonly descriptorPatterns: readonly string[];
  readonly mcc: readonly string[];
  readonly known: boolean;
}

export type MandateDraft =
  | {
      readonly kind: 'draft';
      readonly body: Record<string, unknown>;
      readonly fields: Readonly<Record<string, FieldSource>>;
      readonly notes: readonly string[];
      readonly categories: readonly MerchantCategory[];
      readonly notAfter: string;
    }
  | { readonly kind: 'clarify'; readonly question: string };

function ask(question: string): MandateDraft {
  return { kind: 'clarify', question: `${question} Ask the person; do not guess. Nothing was sent for approval.` };
}

function windowEnd(window: MandateRequest['window'], now: Date): Date | string {
  if ('days' in window) return new Date(now.getTime() + window.days * DAY_MS);
  const end = new Date(`${window.until}T23:59:59.999Z`);
  if (!Number.isFinite(end.getTime())) return 'window.until must be a date, YYYY-MM-DD.';
  if (end.getTime() <= now.getTime()) return `window.until (${window.until}) has already passed.`;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (Date.parse(`${window.until}T00:00:00.000Z`) - today > MAX_WINDOW_DAYS * DAY_MS) {
    return `window.until must be at most ${MAX_WINDOW_DAYS} days from today.`;
  }
  return end;
}

function allowedMerchant(
  entry: { readonly name: string; readonly url?: string },
  categories: readonly MerchantCategory[],
): AllowedMerchant | string {
  const categoryMccs = [...new Set(categories.flatMap((category) => category.mcc))];
  const known = findKnownMerchant(entry.name) ?? (entry.url === undefined ? undefined : findKnownMerchant(entry.url));
  if (known !== undefined) {
    const linked = entry.url === undefined ? known : findKnownMerchant(entry.url);
    if (linked !== known) return `${entry.name} and ${entry.url ?? ''} look like different merchants. Which one is it?`;
    return {
      name: known.name,
      domain: known.domain,
      descriptorPatterns: known.descriptorPatterns,
      mcc: [known.mcc],
      known: true,
    };
  }
  if (entry.url === undefined) {
    return `Acme Pay does not know ${entry.name} yet. What is its website? Send it as merchants[].url.`;
  }
  const domain = hostOf(entry.url);
  if (domain === null) return `The url for ${entry.name} must be its https website.`;
  const resolved = resolveMerchant({
    merchant: entry.name,
    merchantUrl: entry.url,
    category: categories[0]?.key ?? '',
  });
  if (resolved.kind === 'clarify') return resolved.question;
  return {
    name: resolved.merchant.name,
    domain,
    descriptorPatterns: [resolved.merchant.descriptor],
    mcc: categoryMccs,
    known: false,
  };
}

/** Deterministic for a given `now`. */
export function draftMandate(input: {
  readonly request: MandateRequest;
  readonly leveeAgentId: string;
  readonly approverId: string;
  readonly now: Date;
}): MandateDraft {
  const { request, now } = input;
  const cap = request.capMinor;
  if (!Number.isSafeInteger(cap) || cap <= 0 || cap > MAX_AMOUNT_MINOR) {
    return ask(`The amount cap must be a positive amount up to ${formatMoney(MAX_AMOUNT_MINOR, 'USD')}.`);
  }
  const categories: MerchantCategory[] = [];
  for (const key of request.categories) {
    const category = categoryByKey(key);
    if (category === undefined) return ask(`Unknown category ${key}.`);
    if (!categories.includes(category)) categories.push(category);
  }
  if (categories.length === 0) return ask('categories is missing: what kind of purchase is it?');
  const end = windowEnd(request.window, now);
  if (typeof end === 'string') return ask(end);

  const merchants: AllowedMerchant[] = [];
  for (const entry of request.merchants ?? []) {
    const resolved = allowedMerchant(entry, categories);
    if (typeof resolved === 'string') return ask(resolved);
    if (!merchants.some((existing) => existing.domain === resolved.domain)) merchants.push(resolved);
  }

  // Named merchants scope the mandate to them. A known merchant pins its own MCC, the code its card
  // authorizations carry; otherwise the categories' MCCs apply.
  const mccAllow = [...new Set((merchants.length > 0 ? merchants : categories).flatMap((entry) => entry.mcc))];
  const fields: Record<string, FieldSource> = {
    purpose: 'inferred',
    mode: 'inferred',
    'constraints.budget': 'inferred',
    'constraints.budget.max': 'user',
    'constraints.amount_per_txn': 'inferred',
    'constraints.step_up_cap': 'inferred',
    'constraints.mcc': merchants.some((merchant) => merchant.known) ? 'inferred' : 'user',
    ...(merchants.length === 0 ? {} : { 'constraints.merchants': 'user' as const }),
    'constraints.currencies': 'inferred',
    'constraints.window': 'user',
    'constraints.card_not_present_only': 'inferred',
    'out_of_mandate.action': 'inferred',
    'out_of_mandate.challenge_if': 'inferred',
    'out_of_mandate.max_challenges_per_hour': 'inferred',
  };
  const notes = merchants.length === 0 ? ['No store was named, so any store in these categories may qualify.'] : [];
  const labels = categories.map((category) => category.label).join(' and ');
  const purpose =
    merchants.length === 0
      ? `Buy ${labels}`
      : `Buy ${labels} from ${merchants.map((merchant) => merchant.name).join(', ')}`;
  const notAfter = end.toISOString();
  const body = {
    purpose: purpose.slice(0, 200),
    agent_id: input.leveeAgentId,
    approver_id: input.approverId,
    supersedes: null,
    mode: 'autonomous',
    constraints: {
      // The cap is the total; with no separate per-payment limit it is also the per-payment limit.
      amount_per_txn: { currency: 'USD', max: cap },
      budget: { currency: 'USD', max: cap, period: 'lifetime' },
      step_up_cap: { currency: 'USD', max: Math.floor(cap / 4) },
      ...(merchants.length === 0
        ? {}
        : {
            merchants: {
              allow: merchants.map((merchant) => ({
                name: merchant.name,
                website: `https://${merchant.domain}`,
                descriptor_patterns: [...merchant.descriptorPatterns],
              })),
            },
          }),
      mcc: { allow: mccAllow },
      currencies: ['USD'],
      window: { not_before: now.toISOString(), not_after: notAfter },
      card_not_present_only: true,
    },
    agent_binding: { require_network_identity: false, network_keys: [] },
    network_intent: { mirror_to: [], require: false },
    out_of_mandate: {
      action: 'challenge',
      challenge_if: ['amount_over_max_within_25pct'],
      max_challenges_per_hour: 3,
      otherwise: 'decline',
    },
    provenance: { source: 'acme_pay_typed_request', fields: { ...fields } },
    user_request: request.purpose,
    display: { locale: 'en-US' },
  };
  return { kind: 'draft', body, fields, notes, categories, notAfter };
}

import { MAX_AMOUNT_MINOR, decimalToMinor, formatMoney } from '../lib/money';
import type { CategoryKey } from '../merchants/catalog';
import { resolveMerchant } from '../merchants/resolver';

/** What the agent asked to buy. All of it is untrusted. */
export interface PurchaseRequest {
  readonly merchant: string;
  readonly merchantUrl?: string;
  /** Decimal US dollars, "39.99". Exactly one of amount and amountMinor. */
  readonly amount?: string;
  /** Integer US cents. */
  readonly amountMinor?: number;
  readonly description: string;
  readonly category?: string;
}

/** A purchase Acme has resolved and can declare to Levee. */
export interface PurchaseOrder {
  /** Stable key for retries of the same purchase: the merchant's domain. */
  readonly merchantKey: string;
  readonly name: string;
  readonly domain: string;
  readonly descriptor: string;
  readonly mcc: string;
  readonly country: 'USA';
  readonly category: CategoryKey;
  readonly item: string;
  readonly amountMinor: number;
  readonly currency: 'USD';
  readonly merchantUrl?: string;
}

export type OrderResolution =
  { readonly kind: 'order'; readonly order: PurchaseOrder } | { readonly kind: 'clarify'; readonly question: string };

function amountOf(input: PurchaseRequest): number | string {
  if ((input.amount === undefined) === (input.amountMinor === undefined)) {
    return 'Give the price as amount (dollars, "39.99") or amount_minor (cents, 3999), not both.';
  }
  const minor = input.amount === undefined ? input.amountMinor : decimalToMinor(input.amount);
  if (minor === null || minor === undefined || !Number.isSafeInteger(minor) || minor <= 0) {
    return 'The amount must be a positive price in US dollars, such as "39.99".';
  }
  if (minor > MAX_AMOUNT_MINOR)
    return `Acme Pay purchases are limited to ${formatMoney(MAX_AMOUNT_MINOR, 'USD')} each.`;
  return minor;
}

export function orderFromRequest(input: PurchaseRequest): OrderResolution {
  const amount = amountOf(input);
  if (typeof amount === 'string') return { kind: 'clarify', question: amount };
  const item = input.description.trim();
  if (item.length === 0 || item.length > 200) {
    return { kind: 'clarify', question: 'Describe what you are buying in up to 200 characters.' };
  }
  const resolved = resolveMerchant({
    merchant: input.merchant,
    ...(input.merchantUrl === undefined ? {} : { merchantUrl: input.merchantUrl }),
    ...(input.category === undefined ? {} : { category: input.category }),
  });
  if (resolved.kind === 'clarify') return resolved;
  const { name, domain, descriptor, mcc, category } = resolved.merchant;
  return {
    kind: 'order',
    order: {
      merchantKey: domain,
      name,
      domain,
      descriptor,
      mcc,
      country: 'USA',
      category,
      item,
      amountMinor: amount,
      currency: 'USD',
      ...(input.merchantUrl === undefined ? {} : { merchantUrl: input.merchantUrl.trim() }),
    },
  };
}

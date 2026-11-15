import { CATEGORIES, KNOWN_MERCHANTS, categoryByKey, type CategoryKey, type KnownMerchant } from './catalog';

/**
 * Turns the merchant an agent names ("Amazon", "https://shop.example") into the identity Acme
 * declares to Levee and sends on the sandbox swipe: domain, descriptor and MCC. Deterministic, with
 * no network call. It never guesses: an unknown merchant without a website or a category becomes a
 * question for the agent.
 */

export interface ResolvedMerchant {
  readonly name: string;
  readonly domain: string;
  readonly descriptor: string;
  readonly mcc: string;
  readonly category: CategoryKey;
  /** `catalog`: a merchant Acme knows. `category`: an unlisted merchant priced under its declared category. */
  readonly source: 'catalog' | 'category';
}

export type Resolution =
  | { readonly kind: 'resolved'; readonly merchant: ResolvedMerchant }
  | { readonly kind: 'clarify'; readonly question: string };

const MAX_NAME = 100;
const DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,24}$/;
const DESCRIPTOR_UNSAFE = /[^A-Z0-9 .&'/-]/g;

/** Lower case, single spaces, without a leading "the"/"www." or a trailing company suffix. */
export function merchantKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\u2019/g, "'")
    .replace(/[^a-z0-9.&' -]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/,?\s+(?:inc|llc|ltd|corp|co)\.?$/, '')
    .replace(/^(?:the\s+|www\.)/, '')
    .trim();
}

/** The lower-case host of an http(s) URL or a bare host, without `www.`; null when it is not one. */
export function hostOf(value: string): string | null {
  const raw = value.trim();
  if (raw.length === 0 || raw.length > 2_048 || /\s/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  return DOMAIN.test(host) ? host : null;
}

function byHost(host: string): KnownMerchant | undefined {
  return KNOWN_MERCHANTS.find((entry) => host === entry.domain || host.endsWith(`.${entry.domain}`));
}

/** A merchant Acme knows, by name or website. */
export function findKnownMerchant(nameOrHost: string): KnownMerchant | undefined {
  const key = merchantKey(nameOrHost);
  const named = KNOWN_MERCHANTS.find((entry) => entry.aliases.includes(key) || merchantKey(entry.name) === key);
  if (named !== undefined) return named;
  const host = hostOf(nameOrHost);
  return host === null ? undefined : byHost(host);
}

export function categoryChoices(): string {
  const labels = CATEGORIES.map((entry) => `${entry.key} (${entry.label})`);
  return `${labels.slice(0, -1).join(', ')} or ${labels.at(-1) ?? ''}`;
}

/** The merchant's own name as card networks print it. */
export function descriptorFor(name: string): string {
  return name
    .toUpperCase()
    .replace(/\u2019/g, "'")
    .replace(DESCRIPTOR_UNSAFE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 25)
    .trim();
}

function fromCatalog(entry: KnownMerchant): ResolvedMerchant {
  const { name, domain, descriptor, mcc, category } = entry;
  return { name, domain, descriptor, mcc, category, source: 'catalog' };
}

/**
 * A known merchant wins over the agent's category: Acme prices it from its catalog, never from what
 * the agent claims. An unlisted merchant needs both a website and a category.
 */
export function resolveMerchant(query: { merchant: string; merchantUrl?: string; category?: string }): Resolution {
  const name = query.merchant.trim();
  if (name.length === 0 || name.length > MAX_NAME) {
    return { kind: 'clarify', question: `Name the merchant in up to ${MAX_NAME} characters.` };
  }
  let host: string | null = null;
  if (query.merchantUrl !== undefined) {
    host = hostOf(query.merchantUrl);
    if (host === null) {
      return {
        kind: 'clarify',
        question: 'merchant_url must be the merchant’s https website, such as https://example.com.',
      };
    }
  }
  const named = findKnownMerchant(name);
  const linked = host === null ? undefined : byHost(host);
  if (named !== undefined && host !== null && linked !== named) {
    return { kind: 'clarify', question: `${name} and ${host} look like different merchants. Which one is it?` };
  }
  const entry = named ?? linked;
  if (entry !== undefined) return { kind: 'resolved', merchant: fromCatalog(entry) };

  if (query.category === undefined || query.category.trim() === '') {
    return {
      kind: 'clarify',
      question: `Acme Pay does not know ${name} yet. Say what kind of purchase it is: ${categoryChoices()}.`,
    };
  }
  const category = categoryByKey(query.category.trim());
  if (category === undefined) return { kind: 'clarify', question: `category must be one of ${categoryChoices()}.` };
  const domain = host ?? hostOf(name);
  if (domain === null) return { kind: 'clarify', question: `What is ${name}’s website? Send it as merchant_url.` };
  const descriptor = descriptorFor(name);
  if (descriptor.replace(/[^A-Z0-9]/g, '').length < 2) {
    return { kind: 'clarify', question: 'Name the merchant as it appears on its website.' };
  }
  const mcc = category.mcc[0] ?? '5999';
  return { kind: 'resolved', merchant: { name, domain, descriptor, mcc, category: category.key, source: 'category' } };
}

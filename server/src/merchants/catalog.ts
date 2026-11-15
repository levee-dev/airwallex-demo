/**
 * Acme's purchase taxonomy and the merchants it knows. A mandate category and a purchase category
 * are the same words and the same merchant category codes (MCC, ISO 18245).
 *
 * The descriptors and MCCs are sandbox stand-ins for what a card authorization from each merchant
 * would carry, not acquirer-confirmed identities. Levee checks every purchase against the signed
 * mandate and its own payee records; nothing here is trusted by Levee.
 */

export const CATEGORY_KEYS = [
  'marketplace',
  'electronics',
  'books',
  'software',
  'cloud',
  'ads',
  'travel',
  'food_delivery',
  'office_supplies',
] as const;

export type CategoryKey = (typeof CATEGORY_KEYS)[number];

export interface MerchantCategory {
  readonly key: CategoryKey;
  /** Plain words for the approval preview and for questions back to the agent. */
  readonly label: string;
  /** The MCCs a mandate for this category allows. The first is used for an unlisted merchant. */
  readonly mcc: readonly string[];
  /** The category name Levee uses when it learns a new shop. */
  readonly leveeCategory: string;
}

export const CATEGORIES: readonly MerchantCategory[] = [
  // 5942 is included because large online marketplaces often present as book stores.
  {
    key: 'marketplace',
    label: 'general merchandise',
    mcc: ['5399', '5311', '5942', '5999'],
    leveeCategory: 'general_merchandise',
  },
  { key: 'electronics', label: 'electronics', mcc: ['5732', '5045'], leveeCategory: 'electronics' },
  { key: 'books', label: 'books', mcc: ['5942', '5815'], leveeCategory: 'books' },
  { key: 'software', label: 'software', mcc: ['5734', '7372'], leveeCategory: 'software_subscription' },
  { key: 'cloud', label: 'cloud computing', mcc: ['4816', '7372'], leveeCategory: 'cloud_compute' },
  { key: 'ads', label: 'advertising', mcc: ['7311'], leveeCategory: 'advertising' },
  { key: 'travel', label: 'travel', mcc: ['4722', '4511', '7011', '4112'], leveeCategory: 'travel' },
  { key: 'food_delivery', label: 'food delivery', mcc: ['5812', '5814'], leveeCategory: 'food_delivery' },
  { key: 'office_supplies', label: 'office supplies', mcc: ['5943', '5111'], leveeCategory: 'office_supplies' },
];

export function categoryByKey(key: string): MerchantCategory | undefined {
  return CATEGORIES.find((entry) => entry.key === key);
}

/** "Cloud computing" for display. */
export function categoryLabel(key: string): string {
  const label = categoryByKey(key)?.label ?? key.replaceAll('_', ' ');
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
}

/** The plain category word for an MCC; the first category listing the code names it. */
export function categoryLabelForMcc(mcc: string): string {
  const category = CATEGORIES.find((entry) => entry.mcc.includes(mcc));
  return category === undefined ? 'Other' : categoryLabel(category.key);
}

export interface KnownMerchant {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly domain: string;
  /** What Acme's sandbox swipe sends as the card acceptor name. */
  readonly descriptor: string;
  /** The exact descriptors a mandate naming this merchant allows. */
  readonly descriptorPatterns: readonly string[];
  readonly mcc: string;
  readonly category: CategoryKey;
}

function known(
  name: string,
  aliases: readonly string[],
  domain: string,
  descriptor: string,
  mcc: string,
  category: CategoryKey,
  extraPatterns: readonly string[] = [],
): KnownMerchant {
  return { name, aliases, domain, descriptor, descriptorPatterns: [descriptor, ...extraPatterns], mcc, category };
}

export const KNOWN_MERCHANTS: readonly KnownMerchant[] = [
  known('Amazon', ['amazon', 'amazon.com', 'amzn'], 'amazon.com', 'AMAZON.COM', '5942', 'marketplace', [
    'AMZN MKTP US',
  ]),
  known('Walmart', ['walmart', 'walmart.com'], 'walmart.com', 'WALMART.COM', '5311', 'marketplace'),
  known('Target', ['target', 'target.com'], 'target.com', 'TARGET.COM', '5311', 'marketplace'),
  known('eBay', ['ebay', 'ebay.com'], 'ebay.com', 'EBAY', '5999', 'marketplace'),
  known('Best Buy', ['best buy', 'bestbuy', 'bestbuy.com'], 'bestbuy.com', 'BESTBUY.COM', '5732', 'electronics'),
  known('Newegg', ['newegg', 'newegg.com'], 'newegg.com', 'NEWEGG', '5732', 'electronics'),
  known('Apple', ['apple', 'apple store', 'apple.com'], 'apple.com', 'APPLE.COM/US', '5732', 'electronics'),
  known(
    'Barnes & Noble',
    ['barnes & noble', 'barnes and noble', 'barnesandnoble.com'],
    'barnesandnoble.com',
    'BARNES & NOBLE',
    '5942',
    'books',
  ),
  known('GitHub', ['github', 'github.com'], 'github.com', 'GITHUB', '5734', 'software'),
  known('Figma', ['figma', 'figma.com'], 'figma.com', 'FIGMA.COM', '5734', 'software'),
  known(
    'DigitalOcean',
    ['digitalocean', 'digital ocean', 'digitalocean.com'],
    'digitalocean.com',
    'DIGITALOCEAN.COM',
    '4816',
    'cloud',
  ),
  known('LinkedIn Ads', ['linkedin', 'linkedin ads', 'linkedin.com'], 'linkedin.com', 'LINKEDIN', '7311', 'ads'),
  known('Expedia', ['expedia', 'expedia.com'], 'expedia.com', 'EXPEDIA', '4722', 'travel'),
  known('Booking.com', ['booking.com'], 'booking.com', 'BOOKING.COM', '4722', 'travel'),
  known('Uber Eats', ['uber eats', 'ubereats', 'ubereats.com'], 'ubereats.com', 'UBER EATS', '5812', 'food_delivery'),
  known('Grubhub', ['grubhub', 'grubhub.com'], 'grubhub.com', 'GRUBHUB', '5812', 'food_delivery'),
  known('Staples', ['staples', 'staples.com'], 'staples.com', 'STAPLES', '5943', 'office_supplies'),
  known(
    'Office Depot',
    ['office depot', 'officedepot', 'officedepot.com'],
    'officedepot.com',
    'OFFICE DEPOT',
    '5943',
    'office_supplies',
  ),
];

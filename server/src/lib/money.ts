const DECIMAL_AMOUNT = /^(\d{1,6})(?:\.(\d{1,2}))?$/;

/** Largest amount Acme accepts for a mandate cap or a single purchase: $100,000.00. */
export const MAX_AMOUNT_MINOR = 10_000_000;

/** "39.99" to 3999. Null when the text is not a plain decimal amount. */
export function decimalToMinor(value: string): number | null {
  const match = DECIMAL_AMOUNT.exec(value.trim());
  if (match === null) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

/** en-US currency text; whole amounts drop the cents. */
export function formatMoney(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: minor % 100 === 0 ? 0 : 2,
  }).format(minor / 100);
}

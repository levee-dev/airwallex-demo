/** Narrows away undefined and null in tests, failing loudly instead of with a non-null assertion. */
export function defined<T>(value: T | null | undefined, what = 'value'): T {
  if (value === undefined || value === null) throw new Error(`expected ${what} to be defined`);
  return value;
}

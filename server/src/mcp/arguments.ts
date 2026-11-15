import { MAX_AMOUNT_MINOR, decimalToMinor } from '../lib/money';
import { hasControlCharacters, isRecord } from '../lib/values';
import { MAX_WINDOW_DAYS, type MandateRequest } from '../mandates/draft';
import { CATEGORY_KEYS } from '../merchants/catalog';
import type { PurchaseRequest } from '../purchases/order';
import {
  AMOUNT_PATTERN,
  DATE_PATTERN,
  MAX_MERCHANTS,
  MAX_PURPOSE,
  PURCHASE_ID_PATTERN,
  REQUEST_ID_PATTERN,
} from './tools';

/** A JSON-RPC protocol failure: malformed arguments the agent must fix, not ask the person about. */
export class ProtocolError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'ProtocolError';
  }
}

/** A tool failure with a safe, actionable message for the agent. Nothing was sent or charged. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

const INVALID_PARAMS = -32602;
const CATEGORY_LIST = CATEGORY_KEYS.join(', ');

function askPerson(message: string): ToolError {
  return new ToolError(`${message} Ask the person; do not guess. Nothing was sent for approval.`);
}

function rejectExtraKeys(args: Record<string, unknown>, allowed: readonly string[], path = 'arguments'): void {
  const extra = Object.keys(args).find((key) => !allowed.includes(key));
  if (extra !== undefined) throw new ProtocolError(INVALID_PARAMS, `${path}.${extra} is not allowed`);
}

function text(value: unknown, max: number, allowWhitespace = false): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max || hasControlCharacters(trimmed, allowWhitespace)) return null;
  return trimmed;
}

function protocolText(value: unknown, field: string, max: number): string {
  const result = text(value, max);
  if (result === null) throw new ProtocolError(INVALID_PARAMS, `arguments.${field} must be 1-${max} plain characters`);
  return result;
}

function isMinor(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_AMOUNT_MINOR;
}

function isRealDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return DATE_PATTERN.test(value) && Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function requestIdArgument(args: Record<string, unknown>): string {
  rejectExtraKeys(args, ['request_id']);
  if (typeof args.request_id !== 'string' || !REQUEST_ID_PATTERN.test(args.request_id)) {
    throw new ProtocolError(INVALID_PARAMS, 'arguments.request_id must be a request id from acme_request_mandate');
  }
  return args.request_id;
}

export function purchaseIdArgument(args: Record<string, unknown>): string {
  rejectExtraKeys(args, ['purchase_id']);
  if (typeof args.purchase_id !== 'string' || !PURCHASE_ID_PATTERN.test(args.purchase_id)) {
    throw new ProtocolError(INVALID_PARAMS, 'arguments.purchase_id must be a purchase id from acme_purchase');
  }
  return args.purchase_id;
}

export function noArguments(args: Record<string, unknown>): void {
  rejectExtraKeys(args, []);
}

function capMinor(args: Record<string, unknown>): number {
  if (args.amount_cap === undefined && args.amount_cap_minor === undefined) {
    throw askPerson('amount_cap is missing: how much may the agent spend in total?');
  }
  if (args.amount_cap !== undefined && args.amount_cap_minor !== undefined) {
    throw askPerson('Give amount_cap or amount_cap_minor, not both.');
  }
  if (args.amount_cap_minor !== undefined) {
    if (!isMinor(args.amount_cap_minor))
      throw askPerson(`amount_cap_minor must be whole US cents, 1-${MAX_AMOUNT_MINOR}.`);
    return args.amount_cap_minor;
  }
  const minor =
    typeof args.amount_cap === 'string' && AMOUNT_PATTERN.test(args.amount_cap)
      ? decimalToMinor(args.amount_cap)
      : null;
  if (minor === null || minor < 1) throw askPerson('amount_cap must be a positive US dollar amount such as "40.00".');
  return minor;
}

function categories(value: unknown): string[] {
  if (value === undefined)
    throw askPerson(`categories is missing: what kind of purchase is it? One or more of ${CATEGORY_LIST}.`);
  if (!Array.isArray(value) || value.length === 0)
    throw askPerson(`categories must list at least one of ${CATEGORY_LIST}.`);
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !(CATEGORY_KEYS as readonly string[]).includes(entry)) {
      throw askPerson(`categories must each be one of ${CATEGORY_LIST}.`);
    }
    if (!result.includes(entry)) result.push(entry);
  }
  return result;
}

function merchants(value: unknown): { name: string; url?: string }[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MERCHANTS) {
    throw askPerson(
      `merchants must list 1-${MAX_MERCHANTS} stores the person named, or be left out when any store will do.`,
    );
  }
  return value.map((entry: unknown) => {
    if (!isRecord(entry)) throw askPerson('Each merchant must be an object with a name and an optional url.');
    rejectExtraKeys(entry, ['name', 'url'], 'arguments.merchants[]');
    const name = text(entry.name, 100);
    if (name === null) throw askPerson('Each merchant needs a name of 1-100 characters.');
    if (entry.url === undefined) return { name };
    const url = text(entry.url, 2048);
    if (url === null) throw askPerson(`The url for ${name} must be its https website.`);
    return { name, url };
  });
}

function window(value: unknown): MandateRequest['window'] {
  if (value === undefined) throw askPerson('window is missing: for how long may the agent spend?');
  if (!isRecord(value)) throw askPerson('window must be { "days": 1-31 } or { "until": "YYYY-MM-DD" }.');
  rejectExtraKeys(value, ['days', 'until'], 'arguments.window');
  if (Object.keys(value).length !== 1) throw askPerson('Give window.days or window.until, not both.');
  if (value.days !== undefined) {
    const days = value.days;
    if (typeof days !== 'number' || !Number.isSafeInteger(days) || days < 1 || days > MAX_WINDOW_DAYS) {
      throw askPerson(`window.days must be a whole number of days, 1-${MAX_WINDOW_DAYS}.`);
    }
    return { days };
  }
  if (typeof value.until !== 'string' || !isRealDate(value.until))
    throw askPerson('window.until must be a date, YYYY-MM-DD.');
  return { until: value.until };
}

/**
 * Shape checks for acme_request_mandate. An unknown argument is a protocol error; a missing or
 * invalid field is a question for the person, so nothing is guessed and nothing is sent.
 */
export function mandateArguments(args: Record<string, unknown>): MandateRequest {
  rejectExtraKeys(args, ['amount_cap', 'amount_cap_minor', 'currency', 'categories', 'merchants', 'window', 'purpose']);
  const cap = capMinor(args);
  if (args.currency !== undefined && args.currency !== 'USD') throw askPerson('Only USD is supported.');
  const kinds = categories(args.categories);
  const stores = merchants(args.merchants);
  const span = window(args.window);
  if (args.purpose === undefined)
    throw askPerson('purpose is missing: what did the person ask for, in their own words?');
  const purpose = text(args.purpose, MAX_PURPOSE, true);
  if (purpose === null) throw askPerson(`purpose must be the person's own words, 1-${MAX_PURPOSE} characters.`);
  return {
    capMinor: cap,
    categories: kinds,
    ...(stores === undefined ? {} : { merchants: stores }),
    window: span,
    purpose,
  };
}

/** Shape checks for acme_purchase. What the merchant, price and category mean is Acme's to resolve. */
export function purchaseArguments(args: Record<string, unknown>): PurchaseRequest {
  rejectExtraKeys(args, ['merchant', 'merchant_url', 'amount', 'amount_minor', 'currency', 'description', 'category']);
  const merchant = protocolText(args.merchant, 'merchant', 100);
  const description = protocolText(args.description, 'description', 200);
  const merchantUrl =
    args.merchant_url === undefined ? undefined : protocolText(args.merchant_url, 'merchant_url', 2048);
  if ((args.amount === undefined) === (args.amount_minor === undefined)) {
    throw new ProtocolError(INVALID_PARAMS, 'give exactly one of arguments.amount or arguments.amount_minor');
  }
  if (args.amount !== undefined && (typeof args.amount !== 'string' || !AMOUNT_PATTERN.test(args.amount))) {
    throw new ProtocolError(INVALID_PARAMS, 'arguments.amount must be a decimal US dollar amount such as "39.99"');
  }
  if (args.amount_minor !== undefined && !isMinor(args.amount_minor)) {
    throw new ProtocolError(INVALID_PARAMS, `arguments.amount_minor must be whole US cents, 1-${MAX_AMOUNT_MINOR}`);
  }
  if (args.currency !== undefined && args.currency !== 'USD')
    throw new ProtocolError(INVALID_PARAMS, 'arguments.currency must be USD');
  if (
    args.category !== undefined &&
    (typeof args.category !== 'string' || !(CATEGORY_KEYS as readonly string[]).includes(args.category))
  ) {
    throw new ProtocolError(INVALID_PARAMS, `arguments.category must be one of ${CATEGORY_LIST}`);
  }
  return {
    merchant,
    description,
    ...(merchantUrl === undefined ? {} : { merchantUrl }),
    ...(typeof args.amount === 'string' ? { amount: args.amount } : {}),
    ...(typeof args.amount_minor === 'number' ? { amountMinor: args.amount_minor } : {}),
    ...(typeof args.category === 'string' ? { category: args.category } : {}),
  };
}

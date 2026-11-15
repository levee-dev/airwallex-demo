import { CATEGORY_KEYS } from '../merchants/catalog';
import { MAX_WINDOW_DAYS } from '../mandates/draft';
import { MAX_AMOUNT_MINOR } from '../lib/money';

/**
 * The tools an agent sees. None of them can approve, decline, resume or allow anything: only the
 * person's passkey decides. Tools that need the person return an approval link to show verbatim.
 */

export const REQUEST_ID_PATTERN = /^mrq_[A-Za-z0-9_-]{1,128}$/;
export const PURCHASE_ID_PATTERN = /^pur_[A-Za-z0-9_-]{1,128}$/;
export const AMOUNT_PATTERN = /^\d{1,6}(?:\.\d{1,2})?$/;
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_MERCHANTS = 5;
export const MAX_PURPOSE = 500;

const SHOW_LINK =
  'Every time a result carries a link for the person, put it in your reply in full, even if you showed it earlier.';

export const INSTRUCTIONS = [
  'Acme Pay lets you spend on behalf of the person who owns this agent, within a mandate they approve with their passkey.',
  'Use acme_request_mandate to ask for one: fill its fields from what the person said, and ask them for anything they did not say; never guess.',
  'Show approval_url to the person verbatim, then poll acme_request_status every 5 seconds for up to 15 minutes.',
  'acme_purchase pays a merchant the person chose. If it returns approval_required, show the link and wait; after the person approves, retry the same purchase once.',
  'A repeat call while an approval is open returns the same link and charges nothing. If it returns unconfirmed, poll acme_purchase_status and do not retry.',
  'A tool error that asks a question means nothing was sent or charged: ask the person.',
  SHOW_LINK,
].join(' ');

type Schema = Readonly<Record<string, unknown>>;

export interface ToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Schema;
  readonly outputSchema: Schema;
  readonly annotations: Readonly<Record<string, boolean>>;
}

const object = (properties: Schema, required: readonly string[] = []) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required,
});

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

export const TOOLS: readonly ToolDefinition[] = [
  {
    name: 'acme_request_mandate',
    title: 'Request a spending mandate',
    description: `Ask the person to approve a spending mandate. Give the most the agent may spend (amount_cap in US dollars, or amount_cap_minor in cents), the kinds of purchase (categories), how long (window.days, or window.until as a date), the stores only if the person named them, and purpose in the person's own words. Returns awaiting_approval with request_id and approval_url. Show approval_url verbatim, then poll acme_request_status. ${SHOW_LINK}`,
    inputSchema: object(
      {
        amount_cap: {
          type: 'string',
          pattern: AMOUNT_PATTERN.source,
          description: 'Total cap in US dollars, "40.00".',
        },
        amount_cap_minor: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_AMOUNT_MINOR,
          description: 'Total cap in US cents.',
        },
        currency: { type: 'string', enum: ['USD'] },
        categories: {
          type: 'array',
          minItems: 1,
          uniqueItems: true,
          items: { type: 'string', enum: [...CATEGORY_KEYS] },
          description: 'The kinds of purchase the person asked for. A USB-C hub is electronics.',
        },
        merchants: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_MERCHANTS,
          items: object(
            {
              name: { type: 'string', minLength: 1, maxLength: 100 },
              url: {
                type: 'string',
                minLength: 1,
                maxLength: 2048,
                description: "The store's https website, for a store Acme Pay does not know.",
              },
            },
            ['name'],
          ),
          description: 'Only when the person named the stores.',
        },
        window: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          maxProperties: 1,
          properties: {
            days: { type: 'integer', minimum: 1, maximum: MAX_WINDOW_DAYS },
            until: { type: 'string', pattern: DATE_PATTERN.source, description: 'Last day, YYYY-MM-DD (UTC).' },
          },
        },
        purpose: { type: 'string', minLength: 1, maxLength: MAX_PURPOSE, description: "The person's own words." },
      },
      ['categories', 'window', 'purpose'],
    ),
    outputSchema: object(
      {
        request_id: { type: 'string' },
        status: { type: 'string', enum: ['awaiting_approval'] },
        approval_url: { type: 'string' },
        expires_at: { type: 'string' },
        summary: { type: 'string' },
      },
      ['request_id', 'status', 'approval_url', 'expires_at', 'summary'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'acme_request_status',
    title: 'Check a mandate request',
    description: `Read the outcome of a mandate request: awaiting_approval, approved, declined or expired. Poll every 5 seconds while it is awaiting_approval. ${SHOW_LINK}`,
    inputSchema: object({ request_id: { type: 'string', pattern: REQUEST_ID_PATTERN.source } }, ['request_id']),
    outputSchema: object(
      {
        request_id: { type: 'string' },
        status: { type: 'string', enum: ['awaiting_approval', 'approved', 'declined', 'expired'] },
        approval_url: { type: 'string' },
        expires_at: { type: 'string' },
      },
      ['request_id', 'status'],
    ),
    annotations: READ_ONLY,
  },
  {
    name: 'acme_list_mandates',
    title: 'List mandates and open approvals',
    description: `List this agent's mandates with their remaining budget, and every approval still waiting for the person. ${SHOW_LINK}`,
    inputSchema: object({}),
    outputSchema: object(
      {
        mandates: { type: 'array', items: { type: 'object' } },
        approvals: { type: 'array', items: { type: 'object' } },
      },
      ['mandates', 'approvals'],
    ),
    annotations: READ_ONLY,
  },
  {
    name: 'acme_purchase',
    title: 'Buy from a merchant',
    description: `Pay a merchant the person chose, within the approved mandate. Name the merchant, the price in US dollars and what you are buying; for a store Acme Pay does not know, also give merchant_url and category. Returns approved, declined, unconfirmed, or approval_required with approval_url. Every result carries purchase_id. ${SHOW_LINK}`,
    inputSchema: object(
      {
        merchant: { type: 'string', minLength: 1, maxLength: 100 },
        merchant_url: { type: 'string', minLength: 1, maxLength: 2048 },
        amount: { type: 'string', pattern: AMOUNT_PATTERN.source, description: 'Price in US dollars, "39.99".' },
        amount_minor: { type: 'integer', minimum: 1, maximum: MAX_AMOUNT_MINOR, description: 'Price in US cents.' },
        currency: { type: 'string', enum: ['USD'] },
        description: { type: 'string', minLength: 1, maxLength: 200, description: 'What is being bought.' },
        category: { type: 'string', enum: [...CATEGORY_KEYS] },
      },
      ['merchant', 'description'],
    ),
    outputSchema: object(
      {
        purchase_id: { type: 'string' },
        status: { type: 'string', enum: ['approved', 'approval_required', 'declined', 'unconfirmed'] },
        reason: { type: 'string' },
        approval_url: { type: 'string' },
        expires_at: { type: 'string' },
        summary: { type: 'string' },
      },
      ['purchase_id', 'status', 'reason'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'acme_purchase_status',
    title: 'Check a purchase',
    description: `Read a purchase's status: authorized, failed, declined, needs_approval or unconfirmed. charged is true only when authorized. Poll every 5 seconds for up to 2 minutes while unconfirmed; never retry the purchase. ${SHOW_LINK}`,
    inputSchema: object({ purchase_id: { type: 'string', pattern: PURCHASE_ID_PATTERN.source } }, ['purchase_id']),
    outputSchema: object(
      {
        purchase_id: { type: 'string' },
        status: { type: 'string', enum: ['authorized', 'failed', 'declined', 'needs_approval', 'unconfirmed'] },
        reason: { type: 'string' },
        charged: { type: 'boolean' },
        approval_url: { type: 'string' },
        remaining_minor: { type: ['integer', 'null'] },
      },
      ['purchase_id', 'status', 'charged', 'remaining_minor'],
    ),
    annotations: READ_ONLY,
  },
];

import { describe, expect, it } from 'vitest';
import type { DecisionAnswer, DecisionModel } from '../../src/decision-model/client';
import { CHECKS_UNAVAILABLE_NOTE, checkMandateRequest } from '../../src/mandates/checks';
import { draftMandate, type MandateRequest } from '../../src/mandates/draft';
import { categoryByKey } from '../../src/merchants/catalog';
import { mandateArguments, ProtocolError, ToolError } from '../../src/mcp/arguments';
import { defined } from '../support/defined';

const NOW = new Date('2030-01-15T12:00:00.000Z');

function draft(request: Partial<MandateRequest>) {
  return draftMandate({
    request: { capMinor: 4000, categories: ['electronics'], window: { days: 7 }, purpose: 'a hub', ...request },
    leveeAgentId: 'agent_test_1',
    approverId: 'apv_test_1',
    now: NOW,
  });
}

describe('mandate request arguments', () => {
  it('normalizes the cap to cents and de-duplicates categories', () => {
    expect(
      mandateArguments({
        amount_cap: '40.5',
        categories: ['books', 'books'],
        window: { until: '2030-01-20' },
        purpose: ' a book ',
      }),
    ).toEqual({ capMinor: 4050, categories: ['books'], window: { until: '2030-01-20' }, purpose: 'a book' });
  });

  it('asks the person when a field is missing or ambiguous', () => {
    expect(() => mandateArguments({ categories: ['books'], window: { days: 1 }, purpose: 'x' })).toThrow(ToolError);
    expect(() =>
      mandateArguments({
        amount_cap: '1',
        amount_cap_minor: 100,
        categories: ['books'],
        window: { days: 1 },
        purpose: 'x',
      }),
    ).toThrow(/not both/);
    expect(() =>
      mandateArguments({
        amount_cap: '1',
        categories: ['books'],
        window: { days: 1, until: '2030-01-02' },
        purpose: 'x',
      }),
    ).toThrow(/not both/);
    expect(() =>
      mandateArguments({ amount_cap: '1', categories: ['books'], window: { until: '2030-02-30' }, purpose: 'x' }),
    ).toThrow(/YYYY-MM-DD/);
  });

  it('treats unknown arguments as protocol errors', () => {
    expect(() =>
      mandateArguments({ amount_cap: '1', categories: ['books'], window: { days: 1 }, purpose: 'x', approve: true }),
    ).toThrow(ProtocolError);
  });
});

describe('mandate draft', () => {
  it('maps categories to merchant category codes and the cap to budget and per-payment limits', () => {
    const result = draft({ categories: ['electronics', 'books'] });
    if (result.kind !== 'draft') throw new Error(result.question);
    expect(result.body).toMatchObject({
      agent_id: 'agent_test_1',
      approver_id: 'apv_test_1',
      mode: 'autonomous',
      constraints: {
        budget: { currency: 'USD', max: 4000, period: 'lifetime' },
        amount_per_txn: { currency: 'USD', max: 4000 },
        step_up_cap: { currency: 'USD', max: 1000 },
        mcc: { allow: ['5732', '5045', '5942', '5815'] },
        window: { not_before: NOW.toISOString(), not_after: '2030-01-22T12:00:00.000Z' },
        card_not_present_only: true,
      },
    });
    expect(result.fields['constraints.budget.max']).toBe('user');
    expect(result.fields['constraints.amount_per_txn']).toBe('inferred');
    expect(result.notes).toEqual(['No store was named, so any store in these categories may qualify.']);
  });

  it('pins a known merchant to its own descriptors and MCC', () => {
    const result = draft({ merchants: [{ name: 'Best Buy' }] });
    if (result.kind !== 'draft') throw new Error(result.question);
    expect(result.body).toMatchObject({
      constraints: {
        mcc: { allow: ['5732'] },
        merchants: {
          allow: [{ name: 'Best Buy', website: 'https://bestbuy.com', descriptor_patterns: ['BESTBUY.COM'] }],
        },
      },
    });
  });

  it('needs a website for a store it does not know', () => {
    expect(draft({ merchants: [{ name: 'Corner Shop' }] })).toMatchObject({ kind: 'clarify', question: /website/ });
    const resolved = draft({ merchants: [{ name: 'Corner Shop', url: 'https://corner-shop.example' }] });
    expect(resolved.kind).toBe('draft');
  });

  it('refuses windows in the past or too far away', () => {
    expect(draft({ window: { until: '2030-01-14' } })).toMatchObject({ kind: 'clarify', question: /already passed/ });
    expect(draft({ window: { until: '2030-03-01' } })).toMatchObject({ kind: 'clarify', question: /31 days/ });
  });
});

function model(answers: Record<string, DecisionAnswer>): DecisionModel {
  return { model: 'test-model', decide: () => Promise.resolve(answers) };
}

const REQUEST = {
  purpose: 'a USB-C hub',
  capMinor: 4000,
  categories: [defined(categoryByKey('electronics'))],
  merchants: [],
  windowText: '7 days',
};
const choice = (key: string): DecisionAnswer => ({ type: 'choice', choice: key, probabilities: { [key]: 0.9 } });

describe('optional decision model checks', () => {
  it('are skipped without a model, and the preview says so', async () => {
    expect(await checkMandateRequest(null, REQUEST)).toEqual({
      kind: 'pass',
      checks: { status: 'unavailable' },
      riskNotes: [CHECKS_UNAVAILABLE_NOTE],
    });
  });

  it('are skipped when the model fails, never blocking or loosening', async () => {
    const failing: DecisionModel = { model: 'test-model', decide: () => Promise.reject(new Error('down')) };
    expect(await checkMandateRequest(failing, REQUEST)).toMatchObject({
      kind: 'pass',
      checks: { status: 'unavailable' },
    });
  });

  it('can only tighten: injection refuses, a mismatch asks', async () => {
    const injected = model({
      purpose_match: { type: 'noul', noul: 0.9 },
      injection: { type: 'noul', noul: 0.8 },
      category: choice('electronics'),
    });
    expect(await checkMandateRequest(injected, REQUEST)).toMatchObject({ kind: 'refuse' });
    const mismatch = model({
      purpose_match: { type: 'noul', noul: 0.1 },
      injection: { type: 'noul', noul: 0 },
      category: choice('electronics'),
    });
    expect(await checkMandateRequest(mismatch, REQUEST)).toMatchObject({ kind: 'clarify' });
    const otherKind = model({
      purpose_match: { type: 'noul', noul: 0.9 },
      injection: { type: 'noul', noul: 0 },
      category: choice('travel'),
    });
    expect(await checkMandateRequest(otherKind, REQUEST)).toMatchObject({ kind: 'clarify', question: /travel/ });
  });

  it('passes a matching request with a note, changing nothing else', async () => {
    const good = model({
      purpose_match: { type: 'noul', noul: 0.95 },
      injection: { type: 'noul', noul: 0.01 },
      category: choice('electronics'),
    });
    expect(await checkMandateRequest(good, REQUEST)).toMatchObject({
      kind: 'pass',
      checks: { status: 'passed', model: 'test-model', category: 'electronics' },
    });
  });
});

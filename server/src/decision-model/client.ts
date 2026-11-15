import type { DecisionModelConfig } from '../config';
import { isRecord } from '../lib/values';

/**
 * An optional, provider-agnostic decision model client. It is off unless SYSTEM_ONE_* is configured.
 *
 * Wire shape: `POST {base}/v1/systemone` with `Authorization: Bearer <key>` and a JSON body
 * `{ model, state, questions }`. Each question is a `noul` (probability of yes) or a `choice` (one
 * of named options). Answers come back keyed by question name.
 *
 * Acme uses the answers only to tighten: to stop a mandate request with a question or a refusal, or
 * to pick a category it would otherwise ask about. A passing answer never approves, widens or skips
 * anything, and Levee never sees these answers.
 */

export type DecisionQuestion =
  | { readonly type: 'noul'; readonly instructions: string }
  | { readonly type: 'choice'; readonly instructions: string; readonly criteria: Readonly<Record<string, string>> };

export type DecisionAnswer =
  | { readonly type: 'noul'; readonly noul: number }
  | { readonly type: 'choice'; readonly choice: string; readonly probabilities: Readonly<Record<string, number>> };

export interface DecisionModel {
  readonly model: string;
  decide(
    state: Readonly<Record<string, unknown>>,
    questions: Readonly<Record<string, DecisionQuestion>>,
  ): Promise<Readonly<Record<string, DecisionAnswer>>>;
}

/** A failed call. The reason is a failure class only, never a key, body or header. */
export class DecisionModelError extends Error {
  constructor(readonly reason: 'timeout' | 'network' | 'http' | 'invalid_response') {
    super(`decision model call failed (${reason})`);
    this.name = 'DecisionModelError';
  }
}

const MAX_RESPONSE_BYTES = 256 * 1024;

function isProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function answerFor(question: DecisionQuestion, raw: unknown): DecisionAnswer | null {
  if (!isRecord(raw)) return null;
  if (question.type === 'noul') return isProbability(raw.noul) ? { type: 'noul', noul: raw.noul } : null;
  const options = Object.keys(question.criteria);
  if (typeof raw.choice !== 'string' || !options.includes(raw.choice) || !isRecord(raw.probabilities)) return null;
  const probabilities: Record<string, number> = {};
  for (const option of options) {
    const value = raw.probabilities[option] ?? 0;
    if (!isProbability(value)) return null;
    probabilities[option] = value;
  }
  return { type: 'choice', choice: raw.choice, probabilities };
}

export function createDecisionModel(config: DecisionModelConfig, fetchFn: typeof fetch = fetch): DecisionModel {
  const endpoint = `${config.baseUrl}/v1/systemone`;
  return {
    model: config.model,
    async decide(state, questions) {
      let response: Response;
      try {
        response = await fetchFn(endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify({ model: config.model, state, questions }),
          signal: AbortSignal.timeout(config.timeoutMs),
          redirect: 'error',
        });
      } catch (error) {
        const name = error instanceof Error ? error.name : '';
        throw new DecisionModelError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network');
      }
      if (!response.ok) throw new DecisionModelError('http');
      let parsed: unknown;
      try {
        const text = await response.text();
        if (text.length > MAX_RESPONSE_BYTES) throw new DecisionModelError('invalid_response');
        parsed = JSON.parse(text);
      } catch {
        throw new DecisionModelError('invalid_response');
      }
      if (!isRecord(parsed) || !isRecord(parsed.answers)) throw new DecisionModelError('invalid_response');
      const answers: Record<string, DecisionAnswer> = {};
      for (const [name, question] of Object.entries(questions)) {
        const answer = answerFor(question, parsed.answers[name]);
        if (answer === null) throw new DecisionModelError('invalid_response');
        answers[name] = answer;
      }
      return answers;
    },
  };
}

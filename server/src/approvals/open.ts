import type { Agent } from '../agents/service';
import type { AppContext } from '../context';
import { formatMoney } from '../lib/money';
import type { Mandate } from '../mandates/store';
import { ensureApproval, type OpenApproval } from './store';
import type { FirstPurchaseFacts } from './types';

/** Opens (or returns the open) approval for each thing only the person can decide. */

export function openMandateApproval(
  ctx: AppContext,
  mandate: Mandate,
  agent: Agent,
  version: number,
): Promise<OpenApproval> {
  const { terms } = mandate;
  const total = formatMoney(terms.totalMinor, terms.currency);
  const purpose = terms.purpose.toLowerCase();
  return ensureApproval(ctx, {
    userId: mandate.userId,
    agentId: agent.id,
    mandateId: mandate.id,
    kind: 'mandate',
    target: `${mandate.id}@${version}`,
    version,
    challengeId: null,
    title: `Approve ${total} for ${purpose}`,
    shortTitle: `${agent.name} wants ${total} for ${purpose}`,
    intentQuote: mandate.intent,
    currency: terms.currency,
    budgetRemainingMinor: terms.totalMinor,
  });
}

export function openResumeApproval(
  ctx: AppContext,
  mandate: Mandate,
  agent: Agent,
  version: number,
): Promise<OpenApproval> {
  const { terms } = mandate;
  const total = formatMoney(terms.totalMinor, terms.currency);
  return ensureApproval(ctx, {
    userId: mandate.userId,
    agentId: agent.id,
    mandateId: mandate.id,
    kind: 'resume',
    target: `${mandate.id}@${version}`,
    version,
    challengeId: null,
    title: `Resume ${total} for ${terms.purpose.toLowerCase()}`,
    shortTitle: `Resume ${agent.name}'s ${total} approval`,
    intentQuote: mandate.intent,
    currency: terms.currency,
    budgetRemainingMinor: mandate.budget?.remainingMinor ?? terms.totalMinor,
  });
}

export interface StepUpDetails {
  readonly version: number;
  readonly challengeId: string;
  readonly merchantName: string;
  readonly category: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly budgetRemainingMinor: number | null;
  readonly firstPurchase?: FirstPurchaseFacts;
}

export function openStepUpApproval(
  ctx: AppContext,
  mandate: Mandate,
  agent: Agent,
  details: StepUpDetails,
): Promise<OpenApproval> {
  const amount = formatMoney(details.amountMinor, details.currency);
  const remaining = formatMoney(details.budgetRemainingMinor ?? mandate.terms.totalMinor, details.currency);
  const first = details.firstPurchase !== undefined;
  return ensureApproval(ctx, {
    userId: mandate.userId,
    agentId: agent.id,
    mandateId: mandate.id,
    kind: 'step_up',
    target: details.challengeId,
    version: details.version,
    challengeId: details.challengeId,
    title: first
      ? `First purchase from ${details.merchantName}: approve ${amount}`
      : `${details.merchantName} ${amount} needs your OK (${remaining} left)`,
    shortTitle: first
      ? `First purchase from ${details.merchantName} (${amount}) is waiting for your approval`
      : `Approve ${details.merchantName} ${amount} once`,
    intentQuote: mandate.intent,
    merchant: { name: details.merchantName, category: details.category },
    amountMinor: details.amountMinor,
    currency: details.currency,
    budgetRemainingMinor: details.budgetRemainingMinor,
    ...(details.firstPurchase === undefined ? {} : { firstPurchase: details.firstPurchase }),
  });
}

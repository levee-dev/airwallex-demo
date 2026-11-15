import { and, desc, eq } from 'drizzle-orm';
import type { User } from '../auth/sessions';
import type { AppContext } from '../context';
import type { Database } from '../db/client';
import { mandateVersions, mandates, type BudgetSnapshot, type VersionStatus } from '../db/schema';
import { AppError } from '../lib/errors';
import { LeveeError } from '../levee/client';
import type { LeveeCreatedMandate, LeveeMandateView } from '../levee/types';
import { asInteger, asRecord, asString } from '../lib/values';
import { categoryLabelForMcc } from '../merchants/catalog';
import type { MandateTerms } from './types';

/** Acme's mirror of Levee mandates. Levee owns the state; Acme records what verified events and reads say. */

export type Mandate = typeof mandates.$inferSelect;
export type MandateVersion = typeof mandateVersions.$inferSelect;
export interface MandateWithVersions {
  readonly mandate: Mandate;
  readonly versions: readonly MandateVersion[];
}

/** A cached budget older than this is re-read from Levee when a view needs it. */
export const BUDGET_MAX_AGE_MS = 15_000;

export type AgentMandateStatus = 'none' | 'needs_approval' | 'awaiting_confirmation' | 'active' | 'paused' | 'ended';

/** The version that governs spending: the newest active or paused one, else the newest. */
export function liveVersion(versions: readonly MandateVersion[]): MandateVersion | null {
  const sorted = [...versions].sort((a, b) => b.version - a.version);
  return sorted.find((entry) => entry.status === 'active' || entry.status === 'paused') ?? sorted[0] ?? null;
}

export function mandateStatus(versions: readonly MandateVersion[]): AgentMandateStatus {
  const live = liveVersion(versions);
  switch (live?.status) {
    case undefined:
      return 'none';
    case 'pending_approval':
      return 'needs_approval';
    case 'awaiting_confirmation':
    case 'active':
    case 'paused':
      return live.status;
    default:
      return 'ended';
  }
}

export function isLive(status: AgentMandateStatus): boolean {
  return (
    status === 'needs_approval' || status === 'awaiting_confirmation' || status === 'active' || status === 'paused'
  );
}

export async function loadMandate(db: Database, mandateId: string): Promise<MandateWithVersions | null> {
  const [mandate] = await db.select().from(mandates).where(eq(mandates.id, mandateId));
  if (mandate === undefined) return null;
  const versions = await db.select().from(mandateVersions).where(eq(mandateVersions.mandateId, mandateId));
  return { mandate, versions };
}

export async function mandateForUser(db: Database, user: User, mandateId: string): Promise<MandateWithVersions> {
  const found = await loadMandate(db, mandateId);
  if (found === null || found.mandate.userId !== user.id) throw new AppError(404, 'not_found', 'Approval not found.');
  return found;
}

/** The agent's newest mandate, the one its purchases spend against. */
export async function latestMandate(db: Database, agentId: string): Promise<MandateWithVersions | null> {
  const [mandate] = await db
    .select()
    .from(mandates)
    .where(eq(mandates.agentId, agentId))
    .orderBy(desc(mandates.createdAt))
    .limit(1);
  return mandate === undefined ? null : loadMandate(db, mandate.id);
}

export async function setVersion(
  db: Database,
  mandateId: string,
  version: number,
  values: Partial<Pick<MandateVersion, 'status' | 'pendingAction' | 'activationConfirmed'>>,
  now: Date,
): Promise<void> {
  await db
    .update(mandateVersions)
    .set({ ...values, updatedAt: now })
    .where(and(eq(mandateVersions.mandateId, mandateId), eq(mandateVersions.version, version)));
}

function plainPurpose(purpose: string): string {
  const trimmed = purpose.replace(/^buy\s+/i, '').trim();
  return trimmed.length === 0 ? 'Agent spending' : `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

/** The terms as signed, from Levee's create response. */
export function termsFromCreated(created: LeveeCreatedMandate): MandateTerms {
  const constraints = asRecord(created.mandate.constraints);
  const budget = asRecord(constraints.budget);
  const window = asRecord(constraints.window);
  const allow = asRecord(constraints.mcc).allow;
  const codes = Array.isArray(allow) ? allow.filter((code): code is string => typeof code === 'string') : [];
  const provenance = asRecord(asRecord(created.mandate.provenance).fields);
  // With no per-payment limit from the person, Acme sets it equal to the total; that is not a cap
  // the person asked for, so it is not shown as one.
  const perPayment =
    provenance['constraints.amount_per_txn'] === 'inferred'
      ? null
      : asInteger(asRecord(constraints.amount_per_txn).max);
  return {
    currency: asString(budget.currency) ?? 'USD',
    totalMinor: asInteger(budget.max) ?? 0,
    perPurchaseCapMinor: perPayment,
    validUntil: asString(window.not_after) ?? created.approval_expires_at,
    categories: [...new Set(codes.map(categoryLabelForMcc))],
    purpose: plainPurpose(asString(created.mandate.purpose) ?? 'Agent spending'),
  };
}

/**
 * Reads the mandate from Levee and mirrors its card, freeze state and budget. The card's last four
 * digits are shown only once a signed activation event confirmed the version.
 */
export async function refreshMandate(ctx: AppContext, user: User, reference: string): Promise<LeveeMandateView> {
  const levee = await ctx.platform.levee();
  const view = await levee.get<LeveeMandateView>(`/v1/mandates/${encodeURIComponent(reference)}`, user.externalRef);
  const mandateId = reference.split('@')[0] ?? reference;
  const found = await loadMandate(ctx.db, mandateId);
  if (found === null) return view;
  const confirmed = found.versions.filter((entry) => entry.activationConfirmed);
  const values: Partial<Mandate> = {};
  if (confirmed.some((entry) => entry.version === view.version) && /^\d{4}$/.test(view.card_last4 ?? '')) {
    values.cardLast4 = view.card_last4;
  }
  if (view.freeze_status === 'frozen' || view.freeze_status === 'cancelled') values.freezeStatus = 'frozen';
  else if (view.freeze_status === 'failed') values.freezeStatus = 'failed';
  else if (view.freeze_status !== null) values.freezeStatus = 'requested';
  const newestConfirmed = Math.max(0, ...confirmed.map((entry) => entry.version));
  if (view.version >= newestConfirmed && view.remaining_minor !== null) {
    const snapshot: BudgetSnapshot = {
      currency: view.constraints.budget.currency,
      totalMinor: view.constraints.budget.max,
      spentMinor: view.spent_minor,
      remainingMinor: view.remaining_minor,
      readAt: ctx.now().toISOString(),
    };
    values.budget = snapshot;
  }
  if (Object.keys(values).length > 0) await ctx.db.update(mandates).set(values).where(eq(mandates.id, mandateId));
  return view;
}

/** Re-reads budgets older than {@link BUDGET_MAX_AGE_MS}. A failed read keeps the last good copy. */
export async function freshenBudgets(ctx: AppContext, user: User, owned: readonly Mandate[]): Promise<void> {
  const now = ctx.now().getTime();
  for (const mandate of owned) {
    if (mandate.userId !== user.id) continue;
    const readAt = mandate.budget === null ? null : Date.parse(mandate.budget.readAt);
    if (readAt !== null && now - readAt <= BUDGET_MAX_AGE_MS) continue;
    try {
      await refreshMandate(ctx, user, mandate.id);
    } catch (error) {
      if (!(error instanceof LeveeError)) throw error;
    }
  }
}

export function versionStatusLabel(status: VersionStatus): 'active' | 'paused' | 'pending' | 'ended' {
  switch (status) {
    case 'active':
    case 'paused':
      return status;
    case 'pending_approval':
    case 'awaiting_confirmation':
      return 'pending';
    default:
      return 'ended';
  }
}

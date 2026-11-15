import { eq } from 'drizzle-orm';
import type { User } from '../auth/sessions';
import type { AppContext } from '../context';
import { users } from '../db/schema';
import { AppError } from '../lib/errors';
import { LeveeError } from '../levee/client';

/**
 * The end user's card account, opened in the background after sign-up.
 *
 *   approver   Levee approver for the person, created first so the passkey step never waits
 *   create     Airwallex connected account in the person's name (stored once, never a second one)
 *   activate   submit, then simulate onboarding to ACTIVE, retried with backoff
 *   link       Levee accepts the ACTIVE account as the approver's issuer account
 *
 * Every step reads what is already stored and skips what is done, so a run can stop anywhere (a
 * restart, an account left SUBMITTED) and the next run resumes it. Runs for one person never
 * overlap. Cards are issued on the account only once it is ready.
 */

export type AccountStatus = 'opening' | 'ready' | 'failed';

export interface AccountView {
  readonly status: AccountStatus;
  readonly connectedAccountStatus: string | null;
  readonly approverReady: boolean;
  /** Why the last attempt gave up, in plain words; null unless the status is failed. */
  readonly error: string | null;
}

export function cardAccountReady(user: User): boolean {
  return user.connectedAccountStatus === 'ACTIVE' && user.accountLinkedAt !== null && user.approverId !== null;
}

export function accountStatus(user: User): AccountStatus {
  if (cardAccountReady(user)) return 'ready';
  return user.accountError === null ? 'opening' : 'failed';
}

export function accountView(user: User): AccountView {
  const status = accountStatus(user);
  return {
    status,
    connectedAccountStatus: user.connectedAccountStatus,
    approverReady: user.approverId !== null,
    error: status === 'failed' ? user.accountError : null,
  };
}

function splitName(displayName: string): { firstName: string; lastName: string } {
  const [first, ...rest] = displayName.trim().split(/\s+/);
  return { firstName: first || 'Acme', lastName: rest.join(' ') || 'User' };
}

function leveeFailure(error: unknown): unknown {
  if (error instanceof LeveeError) return new AppError(error.status === 422 ? 422 : 502, error.code, error.message);
  return error;
}

async function load(ctx: AppContext, userId: string): Promise<User> {
  const [row] = await ctx.db.select().from(users).where(eq(users.id, userId));
  if (row === undefined) throw new AppError(404, 'not_found', 'User not found.');
  return row;
}

async function update(ctx: AppContext, userId: string, values: Partial<typeof users.$inferInsert>): Promise<User> {
  const [row] = await ctx.db.update(users).set(values).where(eq(users.id, userId)).returning();
  if (row === undefined) throw new AppError(404, 'not_found', 'User not found.');
  return row;
}

const approverRuns = new Map<string, Promise<User>>();

/**
 * The person's Levee approver, created on first need. It does not wait for the card account, so a
 * passkey can be enrolled while the account is still opening. Concurrent callers share one request.
 */
export function ensureApprover(ctx: AppContext, user: User): Promise<User> {
  if (user.approverId !== null) return Promise.resolve(user);
  const running = approverRuns.get(user.id);
  if (running !== undefined) return running;
  const run = (async () => {
    const current = await load(ctx, user.id);
    if (current.approverId !== null) return current;
    const levee = await ctx.platform.levee();
    let approver: { id: string };
    try {
      approver = await levee.post<{ id: string }>('/v1/approvers', {
        kind: 'end_user',
        external_ref: current.externalRef,
      });
    } catch (error) {
      throw leveeFailure(error);
    }
    return update(ctx, current.id, { approverId: approver.id });
  })().finally(() => approverRuns.delete(user.id));
  approverRuns.set(user.id, run);
  return run;
}

/** The approver id, creating the approver when the person has none yet. */
export async function approverFor(ctx: AppContext, user: User): Promise<string> {
  const { approverId } = await ensureApprover(ctx, user);
  if (approverId === null) throw new AppError(500, 'internal', 'The approver could not be recorded.');
  return approverId;
}

/** One pass over every step. Throws when a step cannot finish yet; the stored progress stays. */
export async function provisionOnce(ctx: AppContext, user: User): Promise<User> {
  let current = await ensureApprover(ctx, user);
  const credentials = await ctx.platform.credentials();
  if (current.connectedAccountId === null) {
    const created = await ctx.airwallex.createAccount(credentials.airwallex, {
      email: current.email,
      identifier: current.externalRef,
      ...splitName(current.displayName),
    });
    current = await update(ctx, current.id, { connectedAccountId: created.id, connectedAccountStatus: created.status });
  }
  const accountId = current.connectedAccountId;
  if (accountId === null) throw new AppError(500, 'internal', 'The account could not be recorded.');
  if (current.connectedAccountStatus !== 'ACTIVE') {
    const state = await ctx.airwallex.activate(credentials.airwallex, accountId);
    current = await update(ctx, current.id, { connectedAccountStatus: state.status });
    if (state.status !== 'ACTIVE') {
      throw new AppError(409, 'account_pending', `Your card account is ${state.status.toLowerCase()}.`);
    }
  }
  if (current.accountLinkedAt === null) {
    const approverId = current.approverId;
    if (approverId === null) throw new AppError(500, 'internal', 'The approver could not be recorded.');
    const levee = await ctx.platform.levee();
    try {
      await levee.post(`/v1/approvers/${encodeURIComponent(approverId)}/issuer-account`, {
        issuer_account_ref: accountId,
      });
    } catch (error) {
      throw leveeFailure(error);
    }
    current = await update(ctx, current.id, { accountLinkedAt: ctx.now(), accountError: null });
  }
  return current;
}

/** Waits between whole passes; the activation step has its own shorter backoff inside each pass. */
export const PROVISIONING_DELAYS_MS: readonly number[] = [0, 5_000, 15_000, 45_000];

/** A pass that failed for a reason time may fix: still processing, or a service briefly unreachable. */
export function retryable(error: unknown): boolean {
  if (!(error instanceof AppError)) return false;
  if (error.code === 'platform_not_configured') return false;
  // Levee reads the account from Airwallex itself and can briefly lag behind the activation.
  return error.code === 'account_pending' || error.code === 'issuer_account_inactive' || error.status >= 500;
}

function failureMessage(error: unknown): string {
  if (error instanceof AppError && error.code === 'account_pending') {
    return 'Airwallex has not activated the account yet.';
  }
  return error instanceof AppError ? error.message : 'Something went wrong while opening the account.';
}

const provisioningRuns = new Map<string, Promise<void>>();

async function runProvisioning(ctx: AppContext, userId: string, delays: readonly number[]): Promise<void> {
  let lastError: unknown = null;
  for (const delay of delays) {
    if (delay > 0) await ctx.sleep(delay);
    const user = await load(ctx, userId);
    if (cardAccountReady(user)) return;
    try {
      await provisionOnce(ctx, user);
      return;
    } catch (error) {
      lastError = error;
      if (!retryable(error)) break;
    }
  }
  await update(ctx, userId, { accountError: failureMessage(lastError) });
}

/**
 * Starts (or joins) the background run for this person. The promise never rejects, so callers can
 * fire and forget it; tests await it.
 */
export function startProvisioning(
  ctx: AppContext,
  userId: string,
  delays: readonly number[] = PROVISIONING_DELAYS_MS,
): Promise<void> {
  const running = provisioningRuns.get(userId);
  if (running !== undefined) return running;
  const run = runProvisioning(ctx, userId, delays)
    .catch(() => {
      // The stored progress is kept; the next status read or retry resumes from it.
    })
    .finally(() => provisioningRuns.delete(userId));
  provisioningRuns.set(userId, run);
  return run;
}

export function provisioningInFlight(userId: string): boolean {
  return provisioningRuns.has(userId);
}

/** The running provisioning for this person, or a resolved promise when none is running. */
export function provisioningRun(userId: string): Promise<void> {
  return provisioningRuns.get(userId) ?? Promise.resolve();
}

/**
 * Resumes an account a run left behind (a restart mid-run, an account left SUBMITTED). A failed
 * account waits for the person's retry instead of being retried on every read.
 */
export function resumeProvisioning(ctx: AppContext, user: User): void {
  if (accountStatus(user) === 'opening' && !provisioningInFlight(user.id)) void startProvisioning(ctx, user.id);
}

/** The person asked to try again: clear the failure and start a fresh run. */
export async function retryProvisioning(ctx: AppContext, user: User): Promise<User> {
  if (cardAccountReady(user)) return user;
  const cleared = user.accountError === null ? user : await update(ctx, user.id, { accountError: null });
  void startProvisioning(ctx, user.id);
  return cleared;
}

/** Card issuing (mandate activation) needs the person's own ACTIVE account. */
export function requireCardAccount(user: User): void {
  const status = accountStatus(user);
  if (status === 'ready') return;
  throw new AppError(
    409,
    'card_account_not_ready',
    status === 'failed'
      ? "Your card account couldn't be opened, so no card can be issued yet. Retry it from your Acme Pay dashboard, then approve again."
      : 'Your card account is still opening, so no card can be issued yet. Approve again in a moment.',
  );
}

/** The person's Levee approver; every Levee flow for a person needs it. */
export function requireApprover(user: User): string {
  if (user.approverId === null) {
    throw new AppError(409, 'account_not_ready', 'Finish setting up your account first.');
  }
  return user.approverId;
}

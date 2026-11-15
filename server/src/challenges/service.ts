import { and, eq } from 'drizzle-orm';
import type { User } from '../auth/sessions';
import type { AppContext } from '../context';
import { challenges, mandateVersions, mandates } from '../db/schema';
import { AppError } from '../lib/errors';
import type { LeveeCreatedMandate } from '../levee/types';
import { buildApprovalView } from '../mandates/approval-view';
import { approveMandate, approveOptions, withPasskey, type CeremonyOptions } from '../mandates/decisions';
import { termsFromCreated } from '../mandates/store';
import { finishCeremony, startCeremony, type CeremonyBinding } from '../passkeys/ceremonies';

/**
 * Levee challenges a purchase that needs the person: a step-up over budget, or a first purchase
 * from a new shop. The person allows it once, allows it from now on (a new mandate version they
 * sign separately), or denies it. Acme's mirror moves to its final state only on Levee's events.
 */

export type Challenge = typeof challenges.$inferSelect;

export async function challengeForUser(ctx: AppContext, user: User, challengeId: string): Promise<Challenge> {
  const [challenge] = await ctx.db
    .select()
    .from(challenges)
    .where(and(eq(challenges.id, challengeId), eq(challenges.userId, user.id)));
  if (challenge === undefined) throw new AppError(404, 'not_found', 'Purchase request not found.');
  return challenge;
}

function assertWaiting(challenge: Challenge, allowExtending: boolean): void {
  const waiting = challenge.status === 'pending' || (allowExtending && challenge.status === 'extending');
  if (!waiting) throw new AppError(409, 'not_pending', 'This purchase is no longer waiting for you.');
}

export async function allowOnceOptions(
  ctx: AppContext,
  user: User,
  challengeId: string,
  binding: CeremonyBinding,
): Promise<CeremonyOptions> {
  // An extension still waiting for its own signature does not take "allow once" away.
  assertWaiting(await challengeForUser(ctx, user, challengeId), true);
  const levee = await ctx.platform.levee();
  const result = await levee.post<{ request_id: string; options: unknown }>(
    `/v1/challenges/${encodeURIComponent(challengeId)}/approve/options`,
    {},
    user.externalRef,
  );
  await startCeremony(ctx.db, {
    userId: user.id,
    requestId: result.request_id,
    kind: 'challenge',
    target: challengeId,
    binding,
    now: ctx.now(),
  });
  return { requestId: result.request_id, options: result.options };
}

export async function allowOnce(
  ctx: AppContext,
  user: User,
  input: { challengeId: string; requestId: unknown; response: unknown; binding: CeremonyBinding },
): Promise<void> {
  await challengeForUser(ctx, user, input.challengeId);
  const requestId = await finishCeremony(ctx.db, {
    userId: user.id,
    requestId: input.requestId,
    kind: 'challenge',
    target: input.challengeId,
    binding: input.binding,
    now: ctx.now(),
  });
  const levee = await ctx.platform.levee();
  await withPasskey(() =>
    levee.post(
      `/v1/challenges/${encodeURIComponent(input.challengeId)}/approve`,
      { request_id: requestId, response: input.response },
      user.externalRef,
    ),
  );
  await ctx.db
    .update(challenges)
    .set({ status: 'awaiting_confirmation', resolution: 'allow_once' })
    .where(eq(challenges.id, input.challengeId));
}

/** Asks Levee for the widened next version; the person must sign it like any mandate. */
async function extend(ctx: AppContext, user: User, challenge: Challenge): Promise<number> {
  const levee = await ctx.platform.levee();
  const created = await levee.post<LeveeCreatedMandate>(
    `/v1/challenges/${encodeURIComponent(challenge.id)}/extend`,
    {},
    user.externalRef,
  );
  const fields = created.mandate.provenance as { fields?: Record<string, 'user' | 'inferred' | 'policy'> } | undefined;
  const approval = buildApprovalView({
    created,
    fields: fields?.fields ?? {},
    notes: [`Asked from a purchase at ${challenge.merchantName}.`],
    riskNotes: [],
    checks: { status: 'unavailable' },
  });
  await ctx.db.transaction(async (tx) => {
    await tx
      .insert(mandateVersions)
      .values({ mandateId: challenge.mandateId, version: created.version, status: 'pending_approval', approval })
      .onConflictDoNothing();
    await tx
      .update(mandates)
      .set({ terms: termsFromCreated(created) })
      .where(eq(mandates.id, challenge.mandateId));
    await tx
      .update(challenges)
      .set({ status: 'extending', resolution: 'allow_from_now_on', extensionVersion: created.version })
      .where(eq(challenges.id, challenge.id));
  });
  return created.version;
}

export async function allowFromNowOnOptions(
  ctx: AppContext,
  user: User,
  challengeId: string,
  binding: CeremonyBinding,
): Promise<CeremonyOptions> {
  const challenge = await challengeForUser(ctx, user, challengeId);
  let version = challenge.extensionVersion;
  if (version === null) {
    assertWaiting(challenge, false);
    version = await extend(ctx, user, challenge);
  }
  return approveOptions(ctx, user, challenge.mandateId, version, binding);
}

export async function allowFromNowOn(
  ctx: AppContext,
  user: User,
  input: { challengeId: string; requestId: unknown; response: unknown; binding: CeremonyBinding },
): Promise<void> {
  const challenge = await challengeForUser(ctx, user, input.challengeId);
  if (challenge.extensionVersion === null) {
    throw new AppError(409, 'ceremony_mismatch', 'Start "allow from now on" again from the approval link.');
  }
  await approveMandate(ctx, user, {
    mandateId: challenge.mandateId,
    version: challenge.extensionVersion,
    requestId: input.requestId,
    response: input.response,
    binding: input.binding,
  });
}

export async function denyChallenge(ctx: AppContext, user: User, challengeId: string): Promise<void> {
  assertWaiting(await challengeForUser(ctx, user, challengeId), true);
  const levee = await ctx.platform.levee();
  await levee.post(`/v1/challenges/${encodeURIComponent(challengeId)}/deny`, {}, user.externalRef);
  await ctx.db.update(challenges).set({ resolution: 'deny' }).where(eq(challenges.id, challengeId));
}

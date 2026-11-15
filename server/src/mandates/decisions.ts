import { requireApprover, requireCardAccount } from '../accounts/provisioning';
import type { User } from '../auth/sessions';
import type { AppContext } from '../context';
import { AppError } from '../lib/errors';
import { LeveeError } from '../levee/client';
import { asRecord } from '../lib/values';
import { finishCeremony, startCeremony, type CeremonyBinding } from '../passkeys/ceremonies';
import { liveVersion, mandateForUser, setVersion } from './store';

/**
 * The person's decisions on a mandate. Levee runs every passkey ceremony and verifies every
 * assertion; Acme relays them, binds each ceremony to the user and target that started it, and
 * moves its mirror only as far as "awaiting confirmation" until Levee's signed event arrives.
 */

export interface CeremonyOptions {
  readonly requestId: string;
  readonly options: unknown;
}

/** Levee refused the assertion: say so plainly instead of passing its error through. */
export async function withPasskey<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    const refused =
      error instanceof LeveeError &&
      (error.code.startsWith('webauthn_') || error.status === 401 || error.status === 403);
    if (refused) throw new AppError(401, 'passkey_rejected', 'That passkey could not be verified. Start again.');
    throw error;
  }
}

async function pendingVersion(ctx: AppContext, user: User, mandateId: string, version: number) {
  const found = await mandateForUser(ctx.db, user, mandateId);
  const entry = found.versions.find((candidate) => candidate.version === version);
  if (entry?.status !== 'pending_approval')
    throw new AppError(409, 'not_pending', 'This approval is not waiting for you.');
  return found;
}

export async function approveOptions(
  ctx: AppContext,
  user: User,
  mandateId: string,
  version: number,
  binding: CeremonyBinding,
): Promise<CeremonyOptions> {
  await pendingVersion(ctx, user, mandateId, version);
  // Approving activates the mandate and Levee issues its card on the person's own account.
  requireCardAccount(user);
  const reference = `${mandateId}@${version}`;
  const levee = await ctx.platform.levee();
  const result = await levee.post<{ request_id: string; webauthn_request: unknown }>(
    `/v1/mandates/${encodeURIComponent(reference)}/approve/options`,
    { approver_id: requireApprover(user) },
    user.externalRef,
  );
  await startCeremony(ctx.db, {
    userId: user.id,
    requestId: result.request_id,
    kind: 'approve',
    target: reference,
    binding,
    now: ctx.now(),
  });
  return { requestId: result.request_id, options: result.webauthn_request };
}

export async function approveMandate(
  ctx: AppContext,
  user: User,
  input: { mandateId: string; version: number; requestId: unknown; response: unknown; binding: CeremonyBinding },
): Promise<void> {
  await pendingVersion(ctx, user, input.mandateId, input.version);
  requireCardAccount(user);
  const reference = `${input.mandateId}@${input.version}`;
  const requestId = await finishCeremony(ctx.db, {
    userId: user.id,
    requestId: input.requestId,
    kind: 'approve',
    target: reference,
    binding: input.binding,
    now: ctx.now(),
  });
  const assertion = asRecord(input.response);
  const proof = asRecord(assertion.response);
  const fields = [assertion.id, proof.authenticatorData, proof.clientDataJSON, proof.signature];
  if (!fields.every((field) => typeof field === 'string' && field.length > 0)) {
    throw new AppError(400, 'response_required', 'A passkey assertion is required.');
  }
  const levee = await ctx.platform.levee();
  await withPasskey(() =>
    levee.post(
      `/v1/mandates/${encodeURIComponent(reference)}/approve`,
      {
        request_id: requestId,
        credential_id: assertion.id,
        authenticator_data: proof.authenticatorData,
        client_data_json: proof.clientDataJSON,
        signature: proof.signature,
      },
      user.externalRef,
    ),
  );
  await setVersion(ctx.db, input.mandateId, input.version, { status: 'awaiting_confirmation' }, ctx.now());
}

export async function declineMandate(ctx: AppContext, user: User, mandateId: string, version: number): Promise<void> {
  await pendingVersion(ctx, user, mandateId, version);
  const levee = await ctx.platform.levee();
  await levee.post(
    `/v1/mandates/${encodeURIComponent(`${mandateId}@${version}`)}/decline`,
    { approver_id: requireApprover(user) },
    user.externalRef,
  );
  await setVersion(ctx.db, mandateId, version, { pendingAction: 'decline' }, ctx.now());
}

async function pausedReference(
  ctx: AppContext,
  user: User,
  mandateId: string,
): Promise<{ reference: string; version: number }> {
  const { versions } = await mandateForUser(ctx.db, user, mandateId);
  const live = liveVersion(versions);
  if (live?.status !== 'paused') throw new AppError(409, 'invalid_state', 'This mandate is not paused.');
  return { reference: `${mandateId}@${live.version}`, version: live.version };
}

export async function resumeOptions(
  ctx: AppContext,
  user: User,
  mandateId: string,
  binding: CeremonyBinding,
): Promise<CeremonyOptions> {
  const { reference } = await pausedReference(ctx, user, mandateId);
  const levee = await ctx.platform.levee();
  const result = await levee.post<{ request_id: string; options: unknown }>(
    `/v1/mandates/${encodeURIComponent(reference)}/resume/options`,
    {},
    user.externalRef,
  );
  await startCeremony(ctx.db, {
    userId: user.id,
    requestId: result.request_id,
    kind: 'resume',
    target: reference,
    binding,
    now: ctx.now(),
  });
  return { requestId: result.request_id, options: result.options };
}

export async function resumeMandate(
  ctx: AppContext,
  user: User,
  input: { mandateId: string; requestId: unknown; response: unknown; binding: CeremonyBinding },
): Promise<void> {
  const { reference, version } = await pausedReference(ctx, user, input.mandateId);
  const requestId = await finishCeremony(ctx.db, {
    userId: user.id,
    requestId: input.requestId,
    kind: 'resume',
    target: reference,
    binding: input.binding,
    now: ctx.now(),
  });
  const levee = await ctx.platform.levee();
  await withPasskey(() =>
    levee.post(
      `/v1/mandates/${encodeURIComponent(reference)}/resume`,
      { request_id: requestId, response: input.response },
      user.externalRef,
    ),
  );
  await setVersion(ctx.db, input.mandateId, version, { pendingAction: 'resume' }, ctx.now());
}

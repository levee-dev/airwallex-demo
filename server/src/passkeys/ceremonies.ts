import { eq, lte } from 'drizzle-orm';
import type { Database } from '../db/client';
import { ceremonies } from '../db/schema';
import { AppError } from '../lib/errors';

export type CeremonyKind = 'register' | 'approve' | 'resume' | 'challenge';

/** Ties a ceremony started from an approval link to that approval and the action chosen there. */
export interface CeremonyBinding {
  readonly approvalId: string;
  readonly action: string;
}

const CEREMONY_TTL_MS = 5 * 60_000;

/** Records a passkey ceremony Levee started, so only the same user can finish it, for the same target. */
export async function startCeremony(
  db: Database,
  input: {
    userId: string;
    requestId: string;
    kind: CeremonyKind;
    target: string;
    binding?: CeremonyBinding;
    now: Date;
  },
): Promise<void> {
  await db.delete(ceremonies).where(lte(ceremonies.expiresAt, input.now));
  await db.insert(ceremonies).values({
    requestId: input.requestId,
    userId: input.userId,
    kind: input.kind,
    target: input.target,
    approvalId: input.binding?.approvalId ?? null,
    action: input.binding?.action ?? null,
    expiresAt: new Date(input.now.getTime() + CEREMONY_TTL_MS),
  });
}

/** Consumes the ceremony; throws when it was not started here, for this target, or has expired. */
export async function finishCeremony(
  db: Database,
  input: {
    userId: string;
    requestId: unknown;
    kind: CeremonyKind;
    target: string;
    binding?: CeremonyBinding;
    now: Date;
  },
): Promise<string> {
  if (typeof input.requestId !== 'string' || input.requestId.length === 0) {
    throw new AppError(400, 'request_id_required', 'request_id is required.');
  }
  const [row] = await db.delete(ceremonies).where(eq(ceremonies.requestId, input.requestId)).returning();
  const matches =
    row !== undefined &&
    row.userId === input.userId &&
    row.kind === input.kind &&
    row.target === input.target &&
    row.expiresAt.getTime() > input.now.getTime() &&
    (input.binding === undefined ||
      (row.approvalId === input.binding.approvalId && row.action === input.binding.action));
  if (!matches) {
    throw new AppError(
      409,
      'ceremony_mismatch',
      'This passkey request was not started here or has expired. Start again.',
    );
  }
  return input.requestId;
}

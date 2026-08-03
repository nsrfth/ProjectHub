import type { Prisma } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';

// v2.23.3 (S-14): the last-enabled-administrator invariant, in one place.
//
// THE INVARIANT
//   At all times there is at least one User with
//     globalRole = ADMIN AND disabledAt IS NULL AND isSystemUser = false
//   — a human who can still sign in and administer the instance. Losing
//   it is unrecoverable from inside the app: no one can promote anyone.
//
// WHY THE OLD CHECKS WERE NOT ENOUGH
//   Every mutation path counted admins and then, in a SEPARATE statement,
//   demoted / disabled / deleted one. Two administrators acting at the
//   same moment both read "2 admins", both concluded "safe", and both
//   removed the other. Read-then-write across statement boundaries has no
//   atomicity in Postgres' default READ COMMITTED, and no amount of
//   in-process locking helps: the backend can run as several processes.
//
// HOW IT IS ENFORCED NOW
//   `withAdminInvariantLock` opens ONE transaction and takes a
//   transaction-scoped Postgres advisory lock on a fixed key before doing
//   anything else. Every path that can remove an enabled administrator
//   runs inside it, so the count and the mutation are serialised against
//   each other across connections AND across backend processes. The lock
//   is released by Postgres when the transaction ends — commit, rollback
//   or connection loss — so there is no leak path.
//
//   `pg_advisory_xact_lock` (blocking) rather than `_try_` on purpose:
//   the loser of a race should wait a few milliseconds and then be told
//   "you would be removing the last admin", not "try again later".
//
// ADDING A NEW PATH
//   Anything that can demote, disable, delete or otherwise strip an
//   enabled administrator must call `withAdminInvariantLock` and, inside
//   it, `assertEnabledAdminSurvives(...)` BEFORE the mutation, and must
//   perform the mutation with the same `tx`. Do not count admins outside
//   the lock: that is exactly the bug this module exists to remove.

// Arbitrary but fixed 64-bit key. Advisory locks share one namespace per
// database, so the value only has to be unique within this app.
const ADMIN_LOCK_KEY = 728_413_501_776_001n;

/**
 * The predicate that defines "an administrator who can actually
 * administer". Disabled admins and the internal system account do NOT
 * count — treating them as survivors is what makes deleting the true
 * last admin look safe.
 */
export const ENABLED_ADMIN_WHERE = {
  globalRole: 'ADMIN',
  disabledAt: null,
  isSystemUser: false,
} as const satisfies Prisma.UserWhereInput;

export type AdminInvariantOperation =
  | 'role_change'
  | 'disable'
  | 'delete'
  | 'directory_sync'
  | 'scim';

/**
 * Thrown inside the guarded transaction so the mutation rolls back
 * cleanly. `withAdminInvariantLock` converts it into a 409 and records a
 * security-audit event; callers outside this module never see it.
 */
export class LastAdminProtectedError extends Error {
  constructor(
    message: string,
    readonly operation: AdminInvariantOperation,
    readonly targetUserIds: string[],
    readonly actorId: string | null,
  ) {
    super(message);
    this.name = 'LastAdminProtectedError';
  }
}

/** Count enabled, non-system administrators, ignoring `excludeUserIds`. */
export async function countEnabledAdmins(
  tx: Prisma.TransactionClient,
  excludeUserIds: string[] = [],
): Promise<number> {
  return tx.user.count({
    where:
      excludeUserIds.length > 0
        ? { ...ENABLED_ADMIN_WHERE, id: { notIn: excludeUserIds } }
        : ENABLED_ADMIN_WHERE,
  });
}

/**
 * Assert that removing `targetUserIds` from the administrator population
 * still leaves at least one enabled, non-system admin behind.
 *
 * MUST be called inside `withAdminInvariantLock`, with the same `tx` the
 * mutation will use — the guarantee comes from count and mutation
 * sharing one locked transaction, not from the count itself.
 */
export async function assertEnabledAdminSurvives(
  tx: Prisma.TransactionClient,
  args: {
    targetUserIds: string[];
    operation: AdminInvariantOperation;
    message: string;
    actorId?: string | null;
  },
): Promise<void> {
  const remaining = await countEnabledAdmins(tx, args.targetUserIds);
  if (remaining >= 1) return;
  throw new LastAdminProtectedError(
    args.message,
    args.operation,
    args.targetUserIds,
    args.actorId ?? null,
  );
}

/**
 * Run `fn` in a transaction that holds the admin advisory lock.
 *
 * A `LastAdminProtectedError` raised inside rolls the whole transaction
 * back — so a blocked operation leaves NO partial state — and surfaces
 * to the caller as the same 409 the pre-v2.23.3 code returned.
 */
export async function withAdminInvariantLock<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  try {
    return await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADMIN_LOCK_KEY})`;
        return fn(tx);
      },
      // Generous relative to the work inside: the lock serialises admin
      // mutations, and waiting is the correct behaviour for the loser of
      // a race.
      { timeout: 20_000 },
    );
  } catch (err) {
    if (err instanceof LastAdminProtectedError) {
      // Audited AFTER the rollback, on the normal client: an event
      // written inside the transaction would have been rolled back with
      // it. Best-effort, like every other audit write.
      await prisma.securityAuditEvent
        .create({
          data: {
            kind: 'admin.last_admin_protected',
            actorId: err.actorId,
            details: {
              operation: err.operation,
              targetUserIds: err.targetUserIds,
              reason: err.message,
            } as never,
          },
        })
        .catch(() => undefined);
      throw Errors.conflict(err.message);
    }
    throw err;
  }
}

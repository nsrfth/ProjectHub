import type { TaskStatus } from '@prisma/client';

export type StatusCommentReason = 'ON_HOLD' | 'DONE';

/**
 * v2.5.58: status transitions that must carry an explanatory comment.
 *
 *  - entering ON_HOLD  → the hold reason (blocker visibility over time)
 *  - requesting DONE   → what was completed (audit trail for reviews)
 *
 * The requirement is evaluated on the REQUESTED status, before the v1.87
 * approval reroute — a require-approval task "completed" by a non-finalizer
 * still captures its completion summary at claim time, even though it lands
 * in PENDING_APPROVAL. The approve/reject decision endpoints are exempt:
 * approval carries its own audit entry (and reject already demands a reason).
 *
 * Mirrored on the frontend in features/tasks/statusComment.ts — keep in sync.
 */
export function statusCommentRequirement(
  from: TaskStatus,
  requested: TaskStatus,
): StatusCommentReason | null {
  if (requested === from) return null;
  if (requested === 'ON_HOLD') return 'ON_HOLD';
  if (requested === 'DONE') return 'DONE';
  return null;
}

import type { TaskStatus } from './api';

export type StatusCommentReason = 'ON_HOLD' | 'DONE';

/**
 * v2.5.58: which status transitions must carry an explanatory comment.
 * Mirrors backend/src/lib/statusComment.ts — keep the two in sync.
 *
 *  - entering ON_HOLD → hold reason (blocker visibility)
 *  - entering DONE    → completion summary (audit trail)
 *
 * The backend evaluates the REQUESTED status, so a require-approval task
 * "completed" by a non-finalizer (rerouted to PENDING_APPROVAL server-side)
 * still needs — and stores — its completion comment.
 */
export function statusCommentRequirement(
  from: TaskStatus,
  to: TaskStatus,
): StatusCommentReason | null {
  if (to === from) return null;
  if (to === 'ON_HOLD') return 'ON_HOLD';
  if (to === 'DONE') return 'DONE';
  return null;
}

/** i18n keys the StatusCommentDialog renders — asserted present in both catalogs by the test. */
export const STATUS_COMMENT_I18N_KEYS = [
  'tasks.statusComment.titleHold',
  'tasks.statusComment.titleDone',
  'tasks.statusComment.hintHold',
  'tasks.statusComment.hintDone',
  'tasks.statusComment.placeholder',
  'tasks.statusComment.confirm',
  'tasks.statusComment.cancel',
] as const;

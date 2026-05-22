import { z } from 'zod';

// Action strings are free-form in the DB (so future code can introduce new
// kinds without a migration), but we surface the known ones to clients so the
// frontend can switch on them safely. Unknown actions are still allowed in
// responses — frontend should fall back to rendering the raw string.
export const KNOWN_ACTIVITY_ACTIONS = [
  'task.created',
  'task.updated',
  'task.status_changed',
  'task.deleted',
  'comment.added',
  'comment.edited',
  'comment.deleted',
] as const;

export const activityResponse = z.object({
  id: z.string(),
  taskId: z.string(),
  actorId: z.string(),
  actorName: z.string(),
  action: z.string(),
  meta: z.unknown(),
  createdAt: z.string(),
});

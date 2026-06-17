import { z } from 'zod';

// v1.82: subtask progress status (distinct from TaskStatus). 5 values.
export const subtaskStatusEnum = z.enum([
  'NOT_STARTED',
  'IN_PROGRESS',
  'WAITING',
  'DEFERRED',
  'DONE',
]);

// v1.41: cross-field "end >= start when both set" rule. Pulled into a
// shared refine so create and update share the message + reason code.
function endNotBeforeStart<
  T extends { startDate?: string | null; endDate?: string | null },
>(v: T): boolean {
  if (!v.startDate || !v.endDate) return true;
  return new Date(v.endDate).getTime() >= new Date(v.startDate).getTime();
}

export const createSubtaskBody = z
  .object({
    title: z.string().min(1).max(200).trim(),
    done: z.boolean().optional(),
    // v1.82: optional initial status; `done` is derived from it server-side.
    status: subtaskStatusEnum.optional(),
    // v1.41: optional scheduling window. ISO datetime; null clears (no
    // effect on create but kept symmetric with update). Empty string
    // would have been ambiguous; we require nullable | omitted instead.
    startDate: z.string().datetime().nullable().optional(),
    endDate: z.string().datetime().nullable().optional(),
    // v1.42: optional assignee at create time. Service validates that
    // the user is a member of the parent task's team. Distinct from the
    // existing v1.19 `responsibleId` (which still auto-defaults to creator
    // and is manager-gated to change).
    assigneeId: z.string().nullable().optional(),
  })
  .refine(endNotBeforeStart, {
    message: 'endDate must be on or after startDate',
    path: ['endDate'],
  });

export const updateSubtaskBody = z
  .object({
    title: z.string().min(1).max(200).trim().optional(),
    done: z.boolean().optional(),
    // v1.82: progress status. Authoritative over `done` when both are sent.
    status: subtaskStatusEnum.optional(),
    // v1.19: responsible change is gated server-side (manager/admin only).
    // Undefined = leave as-is; null = clear.
    responsibleId: z.string().nullable().optional(),
    // v1.42: assignee — anyone with project access can change. Service
    // validates the user is a team member of the parent task's team.
    assigneeId: z.string().nullable().optional(),
    // v1.41: dates — undefined leaves them, null clears.
    startDate: z.string().datetime().nullable().optional(),
    endDate: z.string().datetime().nullable().optional(),
  })
  .refine(
    (v) =>
      v.title !== undefined ||
      v.done !== undefined ||
      v.status !== undefined ||
      v.responsibleId !== undefined ||
      v.assigneeId !== undefined ||
      v.startDate !== undefined ||
      v.endDate !== undefined,
    'Provide at least one field',
  )
  // v1.41: end >= start cross-field check. Only fires when BOTH fields
  // are present in the body (or were present on the row and one is being
  // changed) — the service layer re-applies the rule against the merged
  // row so a partial PATCH that introduces an inverted range still 400s.
  .refine(endNotBeforeStart, {
    message: 'endDate must be on or after startDate',
    path: ['endDate'],
  });

// v1.82: focused status-only update body for the dedicated status endpoint
// (responsible / assignee can use it without the full subtask-edit permission).
export const updateSubtaskStatusBody = z.object({
  status: subtaskStatusEnum,
});

export const subtaskResponse = z.object({
  id: z.string(),
  taskId: z.string(),
  title: z.string(),
  done: z.boolean(),
  status: subtaskStatusEnum,
  responsibleId: z.string().nullable(),
  responsibleName: z.string().nullable(),
  // v1.42: assignee joined for the UI.
  assigneeId: z.string().nullable(),
  assigneeName: z.string().nullable(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  position: z.number().int(),
});

// v1.35: full-permutation subtask reorder. Mirrors the bucket reorder
// contract: the body must contain every subtaskId for the parent task
// in the desired order (no duplicates, no missing, no foreign ids).
// Partial reorders are rejected with 400 — they invite race conditions
// when two clients reorder concurrently.
export const reorderSubtasksBody = z.object({
  subtaskIds: z.array(z.string().min(1)).min(1).max(200),
});

export const reorderSubtasksResponse = z.object({
  items: z.array(subtaskResponse),
});

export type CreateSubtaskBody = z.infer<typeof createSubtaskBody>;
export type UpdateSubtaskBody = z.infer<typeof updateSubtaskBody>;
export type UpdateSubtaskStatusBody = z.infer<typeof updateSubtaskStatusBody>;
export type ReorderSubtasksBody = z.infer<typeof reorderSubtasksBody>;

import { z } from 'zod';

import { refineTaskDueDateRange } from '../lib/calendarDate.js';
import { taskCustomFieldValueResponse } from './customFields.js';
import { currencyEnum } from './currency.js';

export const taskStatusEnum = z.enum(['TODO', 'IN_PROGRESS', 'REVIEW', 'DONE']);
export const taskPriorityEnum = z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']);

// v1.42: shared budget validator. Same shape as the v1.41 Project budget
// rules — non-negative decimal with at most 2 fractional digits, accepted
// as either number or string, null to clear.
const budgetSchema = z
  .union([z.number(), z.string()])
  .nullable()
  .optional()
  .superRefine((v, ctx) => {
    if (v === null || v === undefined) return;
    const s = typeof v === 'number' ? String(v) : v.trim();
    if (s.length === 0) return;
    if (!/^\d+(\.\d{1,2})?$/.test(s)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'must be a non-negative decimal with up to 2 fractional digits',
      });
      return;
    }
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be non-negative' });
    }
  });

export const createTaskBody = z.object({
  title: z.string().min(1).max(200).trim(),
  description: z.string().max(5000).trim().optional(),
  status: taskStatusEnum.optional(),
  priority: taskPriorityEnum.optional(),
  // Empty string from a form field is normalized to null (unassigned).
  assigneeId: z.string().nullable().optional(),
  // v1.78: optional at create — defaults to creator when omitted.
  responsibleId: z.string().nullable().optional(),
  // ISO 8601; backend converts to Date. Client sends `null` to clear.
  // Four date concepts the task model tracks (v1.37):
  //   - startDate   — when work began (informational; no scheduler reads it)
  //   - dueDate     — hard deadline (powers TASK_DUE notifications)
  //   - plannedDate — team's target (powers the timeliness report)
  //   - completedAt — when actually done (auto-fills on status→DONE)
  startDate: z.string().datetime().nullable().optional(),
  dueDate: z.string().datetime().nullable().optional(),
  plannedDate: z.string().datetime().nullable().optional(),
  completedAt: z.string().datetime().nullable().optional(),
  // v1.42: optional task-level budget fields, mirrors Project budget rules.
  plannedBudget: budgetSchema,
  actualSpent: budgetSchema,
  // v1.78.2: optional list of team-label ids to attach at create time.
  // Omitted = no labels (same as existing behaviour). Empty array = no
  // labels (explicit). Each id must belong to the task's team; the
  // service rejects cross-team ids with 400. Deduped server-side. The
  // catalog-based attach/detach endpoints continue to work post-create.
  labelIds: z.array(z.string().min(1)).max(50).optional(),
}).superRefine(refineTaskDueDateRange);

export const updateTaskBody = z
  .object({
    title: z.string().min(1).max(200).trim().optional(),
    description: z.string().max(5000).trim().nullable().optional(),
    status: taskStatusEnum.optional(),
    priority: taskPriorityEnum.optional(),
    assigneeId: z.string().nullable().optional(),
    // v1.19: gated server-side to team MANAGER / global ADMIN.
    responsibleId: z.string().nullable().optional(),
    // v1.37: started-on date. Same shape + governance as the other
    // date fields (subject to the v1.18 manager-only restriction).
    startDate: z.string().datetime().nullable().optional(),
    dueDate: z.string().datetime().nullable().optional(),
    plannedDate: z.string().datetime().nullable().optional(),
    completedAt: z.string().datetime().nullable().optional(),
    // v1.42: optional budget patch — undefined leaves, null clears.
    plannedBudget: budgetSchema,
    actualSpent: budgetSchema,
    // v1.78.2: replace-set semantics on PATCH. Undefined = leave the
    // task's labels alone. An array (including empty) replaces the
    // current set entirely. Same per-id validation as create. The
    // catalog-based POST .../labels/:labelId / DELETE remain available
    // for one-at-a-time edits from the LabelPicker.
    labelIds: z.array(z.string().min(1)).max(50).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Provide at least one field to update');

export const listTasksQuery = z.object({
  status: taskStatusEnum.optional(),
});

// Used by the drag-and-drop endpoint. `beforeTaskId` is the task the dragged
// item is being placed BEFORE in the target column. `null` means "drop at the
// end". The target column is implied by `status`.
export const reorderTaskBody = z.object({
  status: taskStatusEnum,
  beforeTaskId: z.string().nullable(),
});

export type ReorderTaskBody = z.infer<typeof reorderTaskBody>;

export const responsibleCandidateResponse = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string(),
});

export const responsibleCandidatesResponse = z.object({
  items: z.array(responsibleCandidateResponse),
});

export type ResponsibleCandidate = z.infer<typeof responsibleCandidateResponse>;

export const taskLabelResponse = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
});

export const taskSubtaskResponse = z.object({
  id: z.string(),
  taskId: z.string(),
  title: z.string(),
  done: z.boolean(),
  // v1.19: subtask responsible joined for the UI.
  responsibleId: z.string().nullable(),
  responsibleName: z.string().nullable(),
  // v1.42: subtask assignee joined for the UI.
  assigneeId: z.string().nullable(),
  assigneeName: z.string().nullable(),
  // v1.41: optional scheduling window (ISO datetime; UTC midnight).
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  position: z.number().int(),
});

export const taskResponse = z.object({
  id: z.string(),
  projectId: z.string(),
  teamId: z.string(),
  // creatorId is nullable since the creator may have been deleted by an admin
  // (FK SetNull preserves task history).
  creatorId: z.string().nullable(),
  assigneeId: z.string().nullable(),
  // v1.19 (renamed v1.77): assigned Responsible — distinct from assignee.
  // Defaults to creator on create; changes gated to team MANAGER /
  // global ADMIN via the `task.change_responsible` permission.
  responsibleId: z.string().nullable(),
  responsibleName: z.string().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  status: taskStatusEnum,
  priority: taskPriorityEnum,
  // v1.37: started-on date. Null when the task hasn't been marked as
  // started yet.
  startDate: z.string().nullable(),
  dueDate: z.string().nullable(),
  plannedDate: z.string().nullable(),
  completedAt: z.string().nullable(),
  // v1.42: optional task budget fields (fixed-2 strings, null when unset).
  plannedBudget: z.string().nullable(),
  actualSpent: z.string().nullable(),
  // v1.59: inherited from parent project — tasks do not store currency.
  budgetCurrency: currencyEnum,
  position: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  labels: z.array(taskLabelResponse),
  subtasks: z.array(taskSubtaskResponse),
  // v1.29: number of incomplete FINISH_TO_START blockers — drives the
  // kanban lock badge + the TaskDetail status-guard preview. Always
  // present; 0 when there are no blockers or all blockers are DONE.
  incompleteBlockerCount: z.number().int().nonnegative(),
  customFields: z.array(taskCustomFieldValueResponse),
});

export type CreateTaskBody = z.infer<typeof createTaskBody>;
export type UpdateTaskBody = z.infer<typeof updateTaskBody>;
export type ListTasksQuery = z.infer<typeof listTasksQuery>;

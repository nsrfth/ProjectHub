import { z } from 'zod';

import { refineTaskDueDateRange } from '../lib/calendarDate.js';
import { taskCustomFieldValueResponse } from './customFields.js';
import { currencyEnum } from './currency.js';

export const taskStatusEnum = z.enum([
  'TODO',
  'IN_PROGRESS',
  // v2.5.58: parked/blocked. Moving a task here requires `statusComment`.
  'ON_HOLD',
  'REVIEW',
  // v1.87: system-managed approval gate. A task lands here when it is
  // "completed" (moved to DONE) by a non-finalizer while requiresApproval is on.
  // Not selectable directly in the UI status picker.
  'PENDING_APPROVAL',
  'DONE',
]);
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
  // v1.87: optional approval gate. requiresApproval=true needs an approverId
  // (a project-eligible user, validated server-side).
  requiresApproval: z.boolean().optional(),
  approverId: z.string().nullable().optional(),
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
  // v1.93 (PMIS R1): schedule baseline + actual execution dates (manager-gated
  // like the other dates) and a stored 0–100 percent-complete.
  baselineStart: z.string().datetime().nullable().optional(),
  baselineEnd: z.string().datetime().nullable().optional(),
  actualStart: z.string().datetime().nullable().optional(),
  actualEnd: z.string().datetime().nullable().optional(),
  percentComplete: z.number().int().min(0).max(100).optional(),
  // v2.1.1 (PMIS R1 supplement): how percentComplete is interpreted.
  // Prefer the dedicated PUT …/progress endpoint to set both together.
  percentCompleteMode: z.enum(['MANUAL', 'FROM_CHILDREN', 'FROM_STATUS']).optional(),
  // v1.42: optional task-level budget fields, mirrors Project budget rules.
  plannedBudget: budgetSchema,
  actualSpent: budgetSchema,
  // v1.78.2: optional list of team-label ids to attach at create time.
  // Omitted = no labels (same as existing behaviour). Empty array = no
  // labels (explicit). Each id must belong to the task's team; the
  // service rejects cross-team ids with 400. Deduped server-side. The
  // catalog-based attach/detach endpoints continue to work post-create.
  labelIds: z.array(z.string().min(1)).max(50).optional(),
  // v1.97 (PMIS R1): optional WBS parent. When set, the new task nests under
  // this task (must be a live task in the same project) and appends as its last
  // child. Omitted/null = a WBS root (today's behaviour).
  parentId: z.string().nullable().optional(),
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
    // v1.87: toggle the approval gate / change the approver. Status is NOT moved
    // to PENDING_APPROVAL here — that only happens on a DONE transition.
    requiresApproval: z.boolean().optional(),
    approverId: z.string().nullable().optional(),
    // v1.37: started-on date. Same shape + governance as the other
    // date fields (subject to the v1.18 manager-only restriction).
    startDate: z.string().datetime().nullable().optional(),
    dueDate: z.string().datetime().nullable().optional(),
    plannedDate: z.string().datetime().nullable().optional(),
    completedAt: z.string().datetime().nullable().optional(),
    // v1.93 (PMIS R1): baseline/actual dates (manager-gated) + percent-complete.
    baselineStart: z.string().datetime().nullable().optional(),
    baselineEnd: z.string().datetime().nullable().optional(),
    actualStart: z.string().datetime().nullable().optional(),
    actualEnd: z.string().datetime().nullable().optional(),
    percentComplete: z.number().int().min(0).max(100).optional(),
    // v2.1.1 (PMIS R1 supplement): how percentComplete is interpreted.
    percentCompleteMode: z.enum(['MANUAL', 'FROM_CHILDREN', 'FROM_STATUS']).optional(),
    // v2.1 (PMIS R5): zero-duration milestone marker for the Gantt.
    isMilestone: z.boolean().optional(),
    milestoneKind: z.string().max(50).nullable().optional(),
    // v1.42: optional budget patch — undefined leaves, null clears.
    plannedBudget: budgetSchema,
    actualSpent: budgetSchema,
    // v1.78.2: replace-set semantics on PATCH. Undefined = leave the
    // task's labels alone. An array (including empty) replaces the
    // current set entirely. Same per-id validation as create. The
    // catalog-based POST .../labels/:labelId / DELETE remain available
    // for one-at-a-time edits from the LabelPicker.
    labelIds: z.array(z.string().min(1)).max(50).optional(),
    // v2.5.58: mandatory explanatory comment for transitions into ON_HOLD
    // (hold reason) and DONE (completion summary). Stored as a real Comment
    // row in the same transaction as the status change. Optional here —
    // the service 400s (STATUS_COMMENT_REQUIRED) when a gated transition
    // arrives without it.
    statusComment: z.string().min(1).max(10_000).trim().optional(),
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
  // v2.5.58: same contract as updateTaskBody.statusComment — required by the
  // service when the drag crosses into ON_HOLD or DONE.
  statusComment: z.string().min(1).max(10_000).trim().optional(),
});

export type ReorderTaskBody = z.infer<typeof reorderTaskBody>;

// v1.87: approval decision bodies. Approve takes no body; reject requires a
// reason (logged on the activity entry).
export const rejectTaskBody = z.object({
  reason: z.string().min(1).max(2000).trim(),
});

export type RejectTaskBody = z.infer<typeof rejectTaskBody>;

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
  // v1.82: subtask progress status (5-state); `done` is derived (DONE ⇔ true).
  status: z.enum(['NOT_STARTED', 'IN_PROGRESS', 'WAITING', 'DEFERRED', 'DONE']),
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
  // v1.87: approval gate. requiresApproval reflects the per-task setting;
  // approverId/approverName identify the designated approver (joined for the UI).
  requiresApproval: z.boolean(),
  approverId: z.string().nullable(),
  approverName: z.string().nullable(),
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
  // v1.93 (PMIS R1): schedule baseline + actual dates (ISO, null when unset) and
  // the stored percent-complete (0–100).
  baselineStart: z.string().nullable(),
  baselineEnd: z.string().nullable(),
  actualStart: z.string().nullable(),
  actualEnd: z.string().nullable(),
  percentComplete: z.number().int(),
  // v2.1.1 (PMIS R1 supplement): how percentComplete was last set.
  percentCompleteMode: z.enum(['MANUAL', 'FROM_CHILDREN', 'FROM_STATUS']),
  // v1.42: optional task budget fields (fixed-2 strings, null when unset).
  plannedBudget: z.string().nullable(),
  actualSpent: z.string().nullable(),
  // v1.59: inherited from parent project — tasks do not store currency.
  budgetCurrency: currencyEnum,
  position: z.number().int(),
  // v1.97 (PMIS R1): WBS parent id (null = root).
  parentId: z.string().nullable(),
  // v2.1.1 (PMIS R1 supplement): materialized WBS depth (0 = root) and
  // summary flag (true = has at least one live child).
  wbsDepth: z.number().int().nonnegative(),
  isSummary: z.boolean(),
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

// v1.97 (PMIS R1): WBS move. `newParentId` null = promote to a root; otherwise
// nest under that task (same project, not self or a descendant). `position` is
// the 0-based index among the new siblings (clamped to the sibling count).
export const moveTaskBody = z.object({
  newParentId: z.string().nullable(),
  position: z.number().int().min(0),
});

export type MoveTaskBody = z.infer<typeof moveTaskBody>;

// v1.97 (PMIS R1): WBS tree read. Returned as a FLAT list in depth-first
// pre-order — each node carries its derived outline `wbsCode` ("1.2.3"),
// `wbsDepth` (0 = root), `isSummary` (has children), and a `rollupPercentComplete`
// (leaf-weighted average of the subtree; equals own % for a leaf). Clients
// render the tree by indenting on depth or rebuilding from `parentId`.
export const wbsNodeResponse = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  title: z.string(),
  status: taskStatusEnum,
  wbsCode: z.string(),
  wbsDepth: z.number().int().nonnegative(),
  isSummary: z.boolean(),
  childCount: z.number().int().nonnegative(),
  percentComplete: z.number().int(),
  rollupPercentComplete: z.number().int(),
  responsibleId: z.string().nullable(),
  responsibleName: z.string().nullable(),
  startDate: z.string().nullable(),
  dueDate: z.string().nullable(),
  baselineStart: z.string().nullable(),
  baselineEnd: z.string().nullable(),
});

export const wbsResponse = z.object({
  items: z.array(wbsNodeResponse),
});

// v2.1.1 (PMIS R1 supplement): dedicated progress endpoint. mode controls how
// percentComplete is computed; percentComplete is only required for MANUAL.
export const progressBody = z.object({
  percentComplete: z.number().int().min(0).max(100).optional(),
  mode: z.enum(['MANUAL', 'FROM_CHILDREN', 'FROM_STATUS']),
}).superRefine((v, ctx) => {
  if (v.mode === 'MANUAL' && v.percentComplete === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'percentComplete is required for MANUAL mode', path: ['percentComplete'] });
  }
});

export type CreateTaskBody = z.infer<typeof createTaskBody>;
export type UpdateTaskBody = z.infer<typeof updateTaskBody>;
export type ListTasksQuery = z.infer<typeof listTasksQuery>;
export type ProgressBody = z.infer<typeof progressBody>;

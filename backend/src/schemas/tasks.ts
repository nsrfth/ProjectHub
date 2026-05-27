import { z } from 'zod';

export const taskStatusEnum = z.enum(['TODO', 'IN_PROGRESS', 'REVIEW', 'DONE']);
export const taskPriorityEnum = z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']);

export const createTaskBody = z.object({
  title: z.string().min(1).max(200).trim(),
  description: z.string().max(5000).trim().optional(),
  status: taskStatusEnum.optional(),
  priority: taskPriorityEnum.optional(),
  // Empty string from a form field is normalized to null (unassigned).
  assigneeId: z.string().nullable().optional(),
  // ISO 8601; backend converts to Date. Client sends `null` to clear.
  // Three date concepts the task model tracks:
  //   - dueDate     — hard deadline (powers TASK_DUE notifications)
  //   - plannedDate — team's target (powers the timeliness report)
  //   - completedAt — when actually done (auto-fills on status→DONE)
  dueDate: z.string().datetime().nullable().optional(),
  plannedDate: z.string().datetime().nullable().optional(),
  completedAt: z.string().datetime().nullable().optional(),
});

export const updateTaskBody = z
  .object({
    title: z.string().min(1).max(200).trim().optional(),
    description: z.string().max(5000).trim().nullable().optional(),
    status: taskStatusEnum.optional(),
    priority: taskPriorityEnum.optional(),
    assigneeId: z.string().nullable().optional(),
    // v1.19: gated server-side to team MANAGER / global ADMIN.
    technicianId: z.string().nullable().optional(),
    dueDate: z.string().datetime().nullable().optional(),
    plannedDate: z.string().datetime().nullable().optional(),
    completedAt: z.string().datetime().nullable().optional(),
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
  // v1.19: subtask technician joined for the UI.
  technicianId: z.string().nullable(),
  technicianName: z.string().nullable(),
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
  // v1.19: assigned Technician — distinct from assignee. Defaults to creator
  // on create; changes gated to team MANAGER / global ADMIN.
  technicianId: z.string().nullable(),
  technicianName: z.string().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  status: taskStatusEnum,
  priority: taskPriorityEnum,
  dueDate: z.string().nullable(),
  plannedDate: z.string().nullable(),
  completedAt: z.string().nullable(),
  position: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  labels: z.array(taskLabelResponse),
  subtasks: z.array(taskSubtaskResponse),
  // v1.29: number of incomplete FINISH_TO_START blockers — drives the
  // kanban lock badge + the TaskDetail status-guard preview. Always
  // present; 0 when there are no blockers or all blockers are DONE.
  incompleteBlockerCount: z.number().int().nonnegative(),
});

export type CreateTaskBody = z.infer<typeof createTaskBody>;
export type UpdateTaskBody = z.infer<typeof updateTaskBody>;
export type ListTasksQuery = z.infer<typeof listTasksQuery>;

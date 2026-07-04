import { z } from 'zod';
import { taskPriorityEnum } from './tasks.js';

// v2.5.28 (StandaloneTask, Option C): Zod schemas for personal tasks. me-scoped;
// owner-isolated. Dates are ISO strings (service serializes; no Zod Date coercion,
// matching the correspondence convention).

export const standaloneStatusEnum = z.enum(['TODO', 'IN_PROGRESS', 'DONE']);

export const createStandaloneTaskBody = z.object({
  title: z.string().min(1).max(200).trim(),
  description: z.string().max(5000).trim().nullable().optional(),
  priority: taskPriorityEnum.nullable().optional(),
  // UTC-midnight calendar date (zone-neutral), same convention as Task.dueDate.
  dueDate: z.string().datetime().nullable().optional(),
});

export const updateStandaloneTaskBody = z.object({
  title: z.string().min(1).max(200).trim().optional(),
  description: z.string().max(5000).trim().nullable().optional(),
  status: standaloneStatusEnum.optional(),
  priority: taskPriorityEnum.nullable().optional(),
  dueDate: z.string().datetime().nullable().optional(),
});

export const listStandaloneTasksQuery = z.object({
  status: standaloneStatusEnum.optional(),
  q: z.string().max(200).trim().optional(),
  // Quick due filters (ignored for DONE unless status=DONE requested).
  due: z.enum(['overdue', 'today', 'week', 'all']).optional().default('all'),
  // Recently-deleted view: 'active' (default) hides soft-deleted; 'deleted'
  // shows only the trash; 'all' shows both.
  scope: z.enum(['active', 'deleted', 'all']).optional().default('active'),
});

// Dense reorder within one status column.
export const reorderStandaloneTasksBody = z.object({
  status: standaloneStatusEnum,
  orderedIds: z.array(z.string()).min(1).max(500),
});

export const promoteStandaloneTaskBody = z.object({
  projectId: z.string(),
});

export const standaloneTaskItem = z.object({
  id: z.string(),
  ownerId: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  status: standaloneStatusEnum,
  priority: taskPriorityEnum.nullable(),
  dueDate: z.string().nullable(),
  completedAt: z.string().nullable(),
  sortOrder: z.number().int(),
  promotedTaskId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
});

export const standaloneTasksResponse = z.object({
  items: z.array(standaloneTaskItem),
});

export const promoteStandaloneTaskResponse = z.object({
  task: z.object({ id: z.string(), projectId: z.string(), teamId: z.string() }),
  standaloneTaskId: z.string(),
  // Set to 'PROMOTE_PARTIAL' when the task was created but the standalone side
  // could not be finalized (see service). Null on the normal path.
  warning: z.string().nullable(),
});

export type CreateStandaloneTaskBody = z.infer<typeof createStandaloneTaskBody>;
export type UpdateStandaloneTaskBody = z.infer<typeof updateStandaloneTaskBody>;
export type ListStandaloneTasksQuery = z.infer<typeof listStandaloneTasksQuery>;
export type ReorderStandaloneTasksBody = z.infer<typeof reorderStandaloneTasksBody>;
export type PromoteStandaloneTaskBody = z.infer<typeof promoteStandaloneTaskBody>;

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
  dueDate: z.string().datetime().nullable().optional(),
  // When the task was actually completed. Optional on create — usually only
  // set after the fact; auto-filled when status flips to DONE.
  doneAt: z.string().datetime().nullable().optional(),
});

export const updateTaskBody = z
  .object({
    title: z.string().min(1).max(200).trim().optional(),
    description: z.string().max(5000).trim().nullable().optional(),
    status: taskStatusEnum.optional(),
    priority: taskPriorityEnum.optional(),
    assigneeId: z.string().nullable().optional(),
    dueDate: z.string().datetime().nullable().optional(),
    doneAt: z.string().datetime().nullable().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Provide at least one field to update');

export const listTasksQuery = z.object({
  status: taskStatusEnum.optional(),
});

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
  position: z.number().int(),
});

export const taskResponse = z.object({
  id: z.string(),
  projectId: z.string(),
  teamId: z.string(),
  creatorId: z.string(),
  assigneeId: z.string().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  status: taskStatusEnum,
  priority: taskPriorityEnum,
  dueDate: z.string().nullable(),
  doneAt: z.string().nullable(),
  position: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  labels: z.array(taskLabelResponse),
  subtasks: z.array(taskSubtaskResponse),
});

export type CreateTaskBody = z.infer<typeof createTaskBody>;
export type UpdateTaskBody = z.infer<typeof updateTaskBody>;
export type ListTasksQuery = z.infer<typeof listTasksQuery>;

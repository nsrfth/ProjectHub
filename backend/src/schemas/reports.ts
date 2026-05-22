import { z } from 'zod';

// "Tasks done in the last N days" query. Clients always pass a window in days
// rather than an absolute since/until so the server can clip pathological
// inputs (e.g. days=10000) without negotiating ranges.
export const doneTasksQuery = z.object({
  days: z.coerce.number().int().positive().max(365).default(7),
});

export const doneTaskRow = z.object({
  taskId: z.string(),
  taskTitle: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  assigneeId: z.string().nullable(),
  assigneeName: z.string().nullable(),
  doneAt: z.string(),
});

export const doneReportResponse = z.object({
  windowDays: z.number().int().positive(),
  items: z.array(doneTaskRow),
});

export type DoneTasksQuery = z.infer<typeof doneTasksQuery>;

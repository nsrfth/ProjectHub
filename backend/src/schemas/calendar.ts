import { z } from 'zod';

// Calendar feed — list every task in a team whose dueDate (or planned, see
// `field`) falls inside [since, until). Used by the /calendar views page.
export const calendarQuery = z.object({
  since: z.string().datetime(),
  until: z.string().datetime(),
  // Which date field to bucket by. `due` (default) maps to dueDate;
  // `planned` to plannedDate. completedAt isn't here because already-done
  // tasks belong in reports, not the forward-looking calendar.
  field: z.enum(['due', 'planned']).default('due'),
});

export const calendarTaskResponse = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(['TODO', 'IN_PROGRESS', 'REVIEW', 'DONE']),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']),
  dueDate: z.string().nullable(),
  plannedDate: z.string().nullable(),
  completedAt: z.string().nullable(),
  projectId: z.string(),
  projectName: z.string(),
  teamId: z.string(),
  teamName: z.string(),
  teamColor: z.string().nullable(),
  assigneeId: z.string().nullable(),
  assigneeName: z.string().nullable(),
});

export const calendarListResponse = z.object({
  items: z.array(calendarTaskResponse),
});

export type CalendarQuery = z.infer<typeof calendarQuery>;
export type CalendarTaskResponse = z.infer<typeof calendarTaskResponse>;

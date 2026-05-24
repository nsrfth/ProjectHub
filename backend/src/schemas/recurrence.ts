import { z } from 'zod';

export const recurrenceFrequency = z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY']);

// Day-of-week ints follow JS Date.getUTCDay() — 0=Sun…6=Sat.
const weekdayInt = z.number().int().min(0).max(6);

export const recurrenceUpsertBody = z.object({
  frequency: recurrenceFrequency,
  interval: z.number().int().positive().max(365).default(1),
  byWeekday: z.array(weekdayInt).max(7).default([]),
  // Calendar dates — same UTC-midnight contract as Task.dueDate/plannedDate.
  startsOn: z.string().datetime(),
  endsOn: z.string().datetime().nullable().optional(),
  maxCount: z.number().int().positive().nullable().optional(),
  // Day offsets applied to each spawn: null means "don't copy that field".
  // Negative values are permitted (e.g. due 2 days BEFORE the spawn date).
  dueOffsetDays: z.number().int().min(-365).max(365).nullable().optional(),
  plannedOffsetDays: z.number().int().min(-365).max(365).nullable().optional(),
  active: z.boolean().default(true),
});

export const recurrenceResponse = z.object({
  id: z.string(),
  sourceTaskId: z.string(),
  frequency: recurrenceFrequency,
  interval: z.number().int(),
  byWeekday: z.array(z.number().int()),
  startsOn: z.string(),
  endsOn: z.string().nullable(),
  maxCount: z.number().int().nullable(),
  dueOffsetDays: z.number().int().nullable(),
  plannedOffsetDays: z.number().int().nullable(),
  nextRunAt: z.string(),
  spawnedCount: z.number().int(),
  active: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type RecurrenceUpsertBody = z.infer<typeof recurrenceUpsertBody>;

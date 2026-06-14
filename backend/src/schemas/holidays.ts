import { z } from 'zod';

export const holidaySourceEnum = z.enum(['MANUAL', 'IMPORT', 'SYNC']);

export const holidayResponse = z.object({
  id: z.string(),
  date: z.string().datetime(),
  name: z.string(),
  recurring: z.boolean(),
  source: holidaySourceEnum,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const createHolidayBody = z.object({
  date: z.string().datetime(),
  name: z.string().trim().min(1).max(200),
  recurring: z.boolean().optional(),
  source: holidaySourceEnum.optional(),
});

export const updateHolidayBody = z.object({
  date: z.string().datetime().optional(),
  name: z.string().trim().min(1).max(200).optional(),
  recurring: z.boolean().optional(),
});

export type CreateHolidayBody = z.infer<typeof createHolidayBody>;
export type UpdateHolidayBody = z.infer<typeof updateHolidayBody>;

export const importHolidayBody = z.object({
  jalaliYear: z.number().int().min(1300).max(1500),
});

export const importPreviewEntry = z.object({
  date: z.string().datetime(),
  name: z.string(),
  type: z.enum(['national', 'religious']),
  recurring: z.boolean(),
});

export const importConflictEntry = z.object({
  date: z.string().datetime(),
  datasetName: z.string(),
  existingName: z.string(),
  existingSource: holidaySourceEnum,
});

export const importSkippedEntry = z.object({
  date: z.string().datetime(),
  name: z.string(),
  existingName: z.string(),
  reason: z.literal('already_imported'),
});

export const importPreviewResponse = z.object({
  jalaliYear: z.number(),
  added: z.array(importPreviewEntry),
  skipped: z.array(importSkippedEntry),
  conflicts: z.array(importConflictEntry),
});

export const importResultResponse = importPreviewResponse.extend({
  inserted: z.number().int(),
});

export type ImportHolidayBody = z.infer<typeof importHolidayBody>;

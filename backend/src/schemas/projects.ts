import { z } from 'zod';

import { currencyEnum } from './currency.js';
import { calendarDateField, refineCalendarDateRange } from '../lib/calendarDate.js';

export const projectStatusEnum = z.enum(['ACTIVE', 'ARCHIVED', 'ON_HOLD']);

// v1.41: budget fields are optional positive decimals serialized as
// strings on the wire (Decimal has more range than JS number safely
// represents). Accept JSON numbers too, but coerce to a normalised
// string for storage. Two decimal places, non-negative.
const budgetSchema = z
  .union([z.number(), z.string()])
  .nullable()
  .optional()
  .superRefine((v, ctx) => {
    if (v === null || v === undefined) return;
    const s = typeof v === 'number' ? String(v) : v.trim();
    if (s.length === 0) return; // empty string accepted as "no value" by callers
    if (!/^\d+(\.\d{1,2})?$/.test(s)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'must be a non-negative decimal with up to 2 fractional digits',
      });
      return;
    }
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'must be non-negative',
      });
    }
  });

export const createProjectBody = z
  .object({
    name: z.string().min(1).max(120).trim(),
    description: z.string().max(2000).trim().optional(),
    status: projectStatusEnum.optional(),
    accountableId: z.string().nullable().optional(),
    plannedBudget: budgetSchema,
    budgetCurrency: currencyEnum.optional(),
    startDate: calendarDateField,
    endDate: calendarDateField,
  })
  .superRefine(refineCalendarDateRange);

export const updateProjectBody = z
  .object({
    name: z.string().min(1).max(120).trim().optional(),
    description: z.string().max(2000).trim().nullable().optional(),
    status: projectStatusEnum.optional(),
    accountableId: z.string().nullable().optional(),
    plannedBudget: budgetSchema,
    budgetCurrency: currencyEnum.optional(),
    startDate: calendarDateField,
    endDate: calendarDateField,
  })
  .superRefine(refineCalendarDateRange)
  .refine(
    (v) =>
      v.name !== undefined ||
      v.description !== undefined ||
      v.status !== undefined ||
      v.accountableId !== undefined ||
      v.plannedBudget !== undefined ||
      v.budgetCurrency !== undefined ||
      v.startDate !== undefined ||
      v.endDate !== undefined,
    'Provide at least one field to update',
  );

export const projectResponse = z.object({
  id: z.string(),
  teamId: z.string(),
  ownerId: z.string().nullable(),
  accountableId: z.string().nullable(),
  accountableName: z.string().nullable(),
  name: z.string(),
  description: z.string().nullable(),
  status: projectStatusEnum,
  plannedBudget: z.string().nullable(),
  budgetCurrency: currencyEnum,
  startDate: z.string().datetime().nullable(),
  endDate: z.string().datetime().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const projectCrossTeamResponse = projectResponse.extend({
  teamName: z.string(),
  teamSlug: z.string(),
});

export type CreateProjectBody = z.infer<typeof createProjectBody>;
export type UpdateProjectBody = z.infer<typeof updateProjectBody>;

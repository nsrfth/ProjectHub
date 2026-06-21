import { z } from 'zod';

import { currencyEnum } from './currency.js';
import { calendarDateField, refineCalendarDateRange } from '../lib/calendarDate.js';
import { taskLabelResponse } from './tasks.js';

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
    // v1.85: selectable project OWNER at creation. Owner = FULL project access,
    // so it's validated to a team member server-side. Omitted / null → the
    // creator becomes the owner (today's behaviour, non-breaking).
    ownerId: z.string().nullable().optional(),
    accountableId: z.string().nullable().optional(),
    plannedBudget: budgetSchema,
    budgetCurrency: currencyEnum.optional(),
    startDate: calendarDateField,
    endDate: calendarDateField,
    labelIds: z.array(z.string()).optional(),
  })
  .superRefine(refineCalendarDateRange);

export const updateProjectBody = z
  .object({
    name: z.string().min(1).max(120).trim().optional(),
    description: z.string().max(2000).trim().nullable().optional(),
    status: projectStatusEnum.optional(),
    // v1.86: reassignable OWNER from the edit form. Owner = FULL project access,
    // so it's validated to a team member server-side and only the current owner
    // or a global ADMIN may set it (managers with rename-only access cannot —
    // it counts as a non-name field).
    ownerId: z.string().nullable().optional(),
    accountableId: z.string().nullable().optional(),
    plannedBudget: budgetSchema,
    budgetCurrency: currencyEnum.optional(),
    startDate: calendarDateField,
    endDate: calendarDateField,
    labelIds: z.array(z.string()).optional(),
  })
  .superRefine(refineCalendarDateRange)
  .refine(
    (v) =>
      v.name !== undefined ||
      v.description !== undefined ||
      v.status !== undefined ||
      v.ownerId !== undefined ||
      v.accountableId !== undefined ||
      v.plannedBudget !== undefined ||
      v.budgetCurrency !== undefined ||
      v.startDate !== undefined ||
      v.endDate !== undefined ||
      v.labelIds !== undefined,
    'Provide at least one field to update',
  );

// v1.86: per-project "full-edit" delegates. The owner (or a global ADMIN) names
// the users who may edit ALL task/subtask fields on this project — including the
// manager-only date fields and the task.change_responsible-gated field — for
// THIS project only. Replace-set semantics, mirroring labelIds.
// v1.88: granular per-delegate capabilities. FULL implies all the others.
export const delegateCapabilityEnum = z.enum([
  'FULL',
  'EDIT_TITLES',
  'EDIT_DETAILS',
  'EDIT_DATES',
  'CHANGE_RESPONSIBLE',
  'DELETE_TASKS',
]);

export const projectDelegateEntry = z.object({
  userId: z.string().min(1),
  capabilities: z.array(delegateCapabilityEnum).min(1),
});

export const projectDelegatesBody = z.object({
  delegates: z.array(projectDelegateEntry).max(100),
});

export const projectDelegatesResponse = z.object({
  delegates: z.array(
    z.object({
      userId: z.string(),
      capabilities: z.array(z.string()),
    }),
  ),
});

// v1.88: self-scoped capabilities — readable by any team member (unlike the
// owner-only list), so the task/subtask UI can unlock the controls a delegate
// is allowed to use without leaking the full set. isDelegate retained (= holds
// FULL) for callers that only need the legacy boolean.
export const projectMyDelegateResponse = z.object({
  isDelegate: z.boolean(),
  capabilities: z.array(z.string()),
});

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
  labels: z.array(taskLabelResponse),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const projectCrossTeamResponse = projectResponse.extend({
  teamName: z.string(),
  teamSlug: z.string(),
});

export type CreateProjectBody = z.infer<typeof createProjectBody>;
export type UpdateProjectBody = z.infer<typeof updateProjectBody>;
export type ProjectDelegatesBody = z.infer<typeof projectDelegatesBody>;

import { z } from 'zod';
import { currencyEnum } from './currency.js';

// v2.0 (PMIS R4 — time tracking): Zod schemas for rate cards, time entries, and
// timesheet periods. Money on the wire is decimal strings (minor units are an
// internal storage detail); `*Minor` fields are echoed as integer strings too.

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const minorInput = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]);
const teamRoleEnum = z.enum(['MANAGER', 'MEMBER']);
const rateScopeEnum = z.enum(['USER', 'ROLE']);
export const timesheetStatusEnum = z.enum([
  'OPEN',
  'SUBMITTED',
  'APPROVED',
  'REJECTED',
  'REOPENED',
]);

export const rateCardResponse = z.object({
  id: z.string(),
  scope: rateScopeEnum,
  userId: z.string().nullable(),
  userName: z.string().nullable(),
  role: teamRoleEnum.nullable(),
  currency: currencyEnum,
  costRateMinor: z.string(),
  costRate: z.string(),
  billRateMinor: z.string().nullable(),
  billRate: z.string().nullable(),
  effectiveFrom: z.string(),
  effectiveTo: z.string().nullable(),
  createdAt: z.string(),
});

export const rateCardListResponse = z.object({ items: z.array(rateCardResponse) });

export const createRateCardBody = z
  .object({
    scope: rateScopeEnum,
    userId: z.string().optional(),
    role: teamRoleEnum.optional(),
    currency: currencyEnum,
    costRateMinor: minorInput,
    billRateMinor: minorInput.optional(),
    effectiveFrom: dateString,
    effectiveTo: dateString.optional(),
  })
  .refine((b) => (b.scope === 'USER' ? !!b.userId : !!b.role), {
    message: 'USER scope requires userId; ROLE scope requires role',
  });

export const updateRateCardBody = z.object({
  currency: currencyEnum.optional(),
  costRateMinor: minorInput.optional(),
  billRateMinor: minorInput.nullable().optional(),
  effectiveFrom: dateString.optional(),
  effectiveTo: dateString.nullable().optional(),
});

export const timeEntryResponse = z.object({
  id: z.string(),
  userId: z.string(),
  userName: z.string().nullable(),
  projectId: z.string(),
  projectName: z.string().nullable(),
  taskId: z.string().nullable(),
  taskTitle: z.string().nullable(),
  periodId: z.string().nullable(),
  status: timesheetStatusEnum,
  date: z.string(),
  minutes: z.number().int(),
  hours: z.string(),
  billable: z.boolean(),
  note: z.string().nullable(),
  costRateMinorSnapshot: z.string().nullable(),
  currencySnapshot: currencyEnum.nullable(),
  createdAt: z.string(),
});

export const timeEntryListResponse = z.object({ items: z.array(timeEntryResponse) });

export const createTimeEntryBody = z.object({
  projectId: z.string(),
  taskId: z.string().optional(),
  date: dateString,
  minutes: z.number().int().min(1).max(1440),
  billable: z.boolean().optional(),
  note: z.string().max(500).optional(),
});

export const bulkTimeEntryBody = z.object({
  entries: z.array(createTimeEntryBody).min(1).max(100),
});

export const updateTimeEntryBody = z.object({
  taskId: z.string().nullable().optional(),
  date: dateString.optional(),
  minutes: z.number().int().min(1).max(1440).optional(),
  billable: z.boolean().optional(),
  note: z.string().max(500).nullable().optional(),
});

export const timesheetPeriodResponse = z.object({
  id: z.string(),
  userId: z.string(),
  userName: z.string().nullable(),
  periodStart: z.string(),
  periodEnd: z.string(),
  status: timesheetStatusEnum,
  submittedAt: z.string().nullable(),
  decidedAt: z.string().nullable(),
  rejectionReason: z.string().nullable(),
  totalMinutes: z.number().int(),
  entryCount: z.number().int(),
  createdAt: z.string(),
});

export const timesheetPeriodListResponse = z.object({
  items: z.array(timesheetPeriodResponse),
});

export const ensurePeriodBody = z.object({
  periodStart: dateString,
  periodEnd: dateString,
});

export const rejectPeriodBody = z.object({ reason: z.string().min(1).max(500) });

export type CreateRateCardBody = z.infer<typeof createRateCardBody>;
export type UpdateRateCardBody = z.infer<typeof updateRateCardBody>;
export type CreateTimeEntryBody = z.infer<typeof createTimeEntryBody>;
export type BulkTimeEntryBody = z.infer<typeof bulkTimeEntryBody>;
export type UpdateTimeEntryBody = z.infer<typeof updateTimeEntryBody>;
export type EnsurePeriodBody = z.infer<typeof ensurePeriodBody>;
export type RejectPeriodBody = z.infer<typeof rejectPeriodBody>;

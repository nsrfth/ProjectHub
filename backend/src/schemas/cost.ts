import { z } from 'zod';
import { currencyEnum } from './currency.js';

// v2.0 (PMIS R4 — cost control): Zod schemas for cost accounts (CBS), budget
// lines, commitments, expenses, the actual-cost ledger, FX rates, and the
// upgraded project cost summary. Money is decimal strings on the wire.

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const minorInput = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]);

export const costEntrySourceEnum = z.enum(['TIMESHEET', 'EXPENSE', 'INVOICE', 'MANUAL']);
export const budgetLineSourceEnum = z.enum(['MIGRATED', 'MANUAL']);
export const commitmentStatusEnum = z.enum(['OPEN', 'CLOSED', 'CANCELLED']);
export const expenseStatusEnum = z.enum(['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED']);

export const costAccountResponse = z.object({
  id: z.string(),
  projectId: z.string(),
  parentId: z.string().nullable(),
  code: z.string(),
  name: z.string(),
  path: z.string(),
  isDefault: z.boolean(),
  childCount: z.number().int(),
  budgetLineCount: z.number().int(),
  createdAt: z.string(),
});
export const costAccountListResponse = z.object({ items: z.array(costAccountResponse) });

export const createCostAccountBody = z.object({
  parentId: z.string().nullable().optional(),
  code: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[A-Za-z0-9_.-]+$/, 'code must be alphanumeric, dash, dot, or underscore')
    .transform((s) => s.toUpperCase()),
  name: z.string().min(1).max(200).trim(),
});
export const updateCostAccountBody = z.object({
  name: z.string().min(1).max(200).trim().optional(),
});

export const budgetLineResponse = z.object({
  id: z.string(),
  projectId: z.string(),
  costAccountId: z.string(),
  costAccountCode: z.string().nullable(),
  taskId: z.string().nullable(),
  amountMinor: z.string(),
  amount: z.string(),
  currency: currencyEnum,
  source: budgetLineSourceEnum,
  note: z.string().nullable(),
  createdAt: z.string(),
});
export const budgetLineListResponse = z.object({ items: z.array(budgetLineResponse) });
export const createBudgetLineBody = z.object({
  costAccountId: z.string().optional(),
  taskId: z.string().nullable().optional(),
  amountMinor: minorInput,
  currency: currencyEnum,
  note: z.string().max(500).optional(),
});

export const commitmentResponse = z.object({
  id: z.string(),
  projectId: z.string(),
  costAccountId: z.string().nullable(),
  vendorName: z.string().nullable(),
  reference: z.string().nullable(),
  amountMinor: z.string(),
  amount: z.string(),
  currency: currencyEnum,
  status: commitmentStatusEnum,
  incurredOn: z.string().nullable(),
  createdAt: z.string(),
});
export const commitmentListResponse = z.object({ items: z.array(commitmentResponse) });
export const createCommitmentBody = z.object({
  costAccountId: z.string().nullable().optional(),
  vendorName: z.string().max(200).optional(),
  reference: z.string().max(100).optional(),
  amountMinor: minorInput,
  currency: currencyEnum,
  incurredOn: dateString.optional(),
});
export const updateCommitmentStatusBody = z.object({ status: commitmentStatusEnum });

export const expenseResponse = z.object({
  id: z.string(),
  projectId: z.string(),
  costAccountId: z.string().nullable(),
  taskId: z.string().nullable(),
  amountMinor: z.string(),
  amount: z.string(),
  currency: currencyEnum,
  status: expenseStatusEnum,
  description: z.string().nullable(),
  incurredOn: z.string(),
  createdAt: z.string(),
});
export const expenseListResponse = z.object({ items: z.array(expenseResponse) });
export const createExpenseBody = z.object({
  costAccountId: z.string().nullable().optional(),
  taskId: z.string().nullable().optional(),
  amountMinor: minorInput,
  currency: currencyEnum,
  description: z.string().max(500).optional(),
  incurredOn: dateString,
});

export const actualCostEntryResponse = z.object({
  id: z.string(),
  projectId: z.string(),
  costAccountId: z.string().nullable(),
  taskId: z.string().nullable(),
  source: costEntrySourceEnum,
  amountMinor: z.string(),
  amount: z.string(),
  currency: currencyEnum,
  baseAmountMinor: z.string(),
  baseAmount: z.string(),
  baseCurrency: currencyEnum,
  incurredOn: z.string(),
  description: z.string().nullable(),
  reversalOfId: z.string().nullable(),
  createdAt: z.string(),
});
export const actualCostEntryListResponse = z.object({
  items: z.array(actualCostEntryResponse),
});
export const createActualCostBody = z.object({
  costAccountId: z.string().nullable().optional(),
  taskId: z.string().nullable().optional(),
  amountMinor: minorInput,
  currency: currencyEnum,
  incurredOn: dateString,
  description: z.string().max(500).optional(),
});

export const fxRateResponse = z.object({
  id: z.string(),
  baseCurrency: currencyEnum,
  quoteCurrency: currencyEnum,
  rate: z.string(),
  asOf: z.string(),
  source: z.string().nullable(),
  createdAt: z.string(),
});
export const fxRateListResponse = z.object({ items: z.array(fxRateResponse) });
export const createFxRateBody = z.object({
  baseCurrency: currencyEnum,
  quoteCurrency: currencyEnum,
  rate: z.string().regex(/^\d+(\.\d{1,8})?$/, 'rate must be a positive decimal'),
  asOf: dateString,
  source: z.string().max(100).optional(),
});

// Per-currency bucket used in the cost summary + budget report rollups.
const currencyBucket = z.object({
  currency: currencyEnum,
  plannedMinor: z.string(),
  committedMinor: z.string(),
  actualMinor: z.string(),
  remainingMinor: z.string(),
  planned: z.string(),
  committed: z.string(),
  actual: z.string(),
  remaining: z.string(),
});

export const projectCostSummaryResponse = z.object({
  projectId: z.string(),
  reportingCurrency: currencyEnum,
  byCurrency: z.array(currencyBucket),
  base: z.object({
    currency: currencyEnum,
    plannedMinor: z.string(),
    committedMinor: z.string(),
    actualMinor: z.string(),
    remainingMinor: z.string(),
    planned: z.string(),
    committed: z.string(),
    actual: z.string(),
    remaining: z.string(),
    warnings: z.array(z.string()),
  }),
});

export type CreateCostAccountBody = z.infer<typeof createCostAccountBody>;
export type UpdateCostAccountBody = z.infer<typeof updateCostAccountBody>;
export type CreateBudgetLineBody = z.infer<typeof createBudgetLineBody>;
export type CreateCommitmentBody = z.infer<typeof createCommitmentBody>;
export type UpdateCommitmentStatusBody = z.infer<typeof updateCommitmentStatusBody>;
export type CreateExpenseBody = z.infer<typeof createExpenseBody>;
export type CreateActualCostBody = z.infer<typeof createActualCostBody>;
export type CreateFxRateBody = z.infer<typeof createFxRateBody>;

import { z } from 'zod';
import { currencyEnum } from './currency.js';

// v1.99 (PMIS R3 — portfolio / program): Zod schemas for the OrgUnit tree,
// project attach, and subtree roll-up reports.

export const orgUnitTypeEnum = z.enum(['HOLDING', 'PORTFOLIO', 'PROGRAM']);

export const orgUnitResponse = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  type: orgUnitTypeEnum,
  name: z.string(),
  code: z.string(),
  path: z.string(),
  managerId: z.string().nullable(),
  managerName: z.string().nullable(),
  currency: currencyEnum.nullable(),
  childCount: z.number().int(),
  projectCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const orgUnitTreeNode: z.ZodType<
  z.infer<typeof orgUnitResponse> & { children: z.infer<typeof orgUnitTreeNode>[] }
> = z.lazy(() =>
  orgUnitResponse.extend({
    children: z.array(orgUnitTreeNode),
  }),
);

export const orgUnitListResponse = z.object({
  items: z.array(orgUnitResponse),
});

export const orgUnitTreeResponse = z.object({
  items: z.array(orgUnitTreeNode),
});

export const createOrgUnitBody = z.object({
  parentId: z.string().nullable().optional(),
  type: orgUnitTypeEnum,
  name: z.string().min(1).max(200).trim(),
  code: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[A-Za-z0-9_-]+$/, 'code must be alphanumeric, dash, or underscore')
    .transform((s) => s.toUpperCase()),
  managerId: z.string().nullable().optional(),
  currency: currencyEnum.nullable().optional(),
});

export const updateOrgUnitBody = z.object({
  name: z.string().min(1).max(200).trim().optional(),
  managerId: z.string().nullable().optional(),
  currency: currencyEnum.nullable().optional(),
});

export const moveOrgUnitBody = z.object({
  newParentId: z.string().nullable(),
});

export const setProjectOrgUnitBody = z.object({
  orgUnitId: z.string().nullable(),
});

export const orgUnitIdParams = z.object({ orgUnitId: z.string() });

export const portfolioSummaryReport = z.object({
  orgUnitId: z.string(),
  orgUnitName: z.string(),
  projectCount: z.number().int(),
  activeCount: z.number().int(),
  onHoldCount: z.number().int(),
  archivedCount: z.number().int(),
  openTaskCount: z.number().int(),
  overdueTaskCount: z.number().int(),
});

export const portfolioProgressReport = z.object({
  orgUnitId: z.string(),
  orgUnitName: z.string(),
  projectCount: z.number().int(),
  avgPercentComplete: z.number().int(),
  projects: z.array(
    z.object({
      projectId: z.string(),
      projectName: z.string(),
      teamId: z.string(),
      teamName: z.string(),
      percentComplete: z.number().int(),
    }),
  ),
});

export const portfolioRagReport = z.object({
  orgUnitId: z.string(),
  orgUnitName: z.string(),
  projectCount: z.number().int(),
  byStatus: z.object({
    GREEN: z.number().int(),
    AMBER: z.number().int(),
    RED: z.number().int(),
  }),
});

export const portfolioCostReport = z.object({
  orgUnitId: z.string(),
  orgUnitName: z.string(),
  projectCount: z.number().int(),
  rollupByCurrency: z.array(
    z.object({
      currency: currencyEnum,
      projectCount: z.number().int(),
      projectsWithBudget: z.number().int(),
      totalPlanned: z.string().nullable(),
    }),
  ),
});

export const portfolioEvmReport = z.object({
  orgUnitId: z.string(),
  orgUnitName: z.string(),
  available: z.literal(false),
  message: z.string(),
});

export type CreateOrgUnitBody = z.infer<typeof createOrgUnitBody>;
export type UpdateOrgUnitBody = z.infer<typeof updateOrgUnitBody>;
export type MoveOrgUnitBody = z.infer<typeof moveOrgUnitBody>;
export type SetProjectOrgUnitBody = z.infer<typeof setProjectOrgUnitBody>;

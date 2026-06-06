import { z } from 'zod';

export const projectStatusEnum = z.enum(['ACTIVE', 'ARCHIVED', 'ON_HOLD']);

export const createProjectBody = z.object({
  name: z.string().min(1).max(120).trim(),
  description: z.string().max(2000).trim().optional(),
  // v1.17: RACI "Accountable" person — optional team member id. Service
  // validates that the user is a team member before saving.
  accountableId: z.string().nullable().optional(),
});

export const updateProjectBody = z
  .object({
    name: z.string().min(1).max(120).trim().optional(),
    description: z.string().max(2000).trim().nullable().optional(),
    status: projectStatusEnum.optional(),
    // Explicit null = clear; undefined = leave as-is.
    accountableId: z.string().nullable().optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.description !== undefined ||
      v.status !== undefined ||
      v.accountableId !== undefined,
    'Provide at least one field to update',
  );

export const projectResponse = z.object({
  id: z.string(),
  teamId: z.string(),
  // Nullable since the owning user may have been deleted (FK SetNull).
  ownerId: z.string().nullable(),
  // v1.17: same nullability story — accountable user can be deleted; the
  // FK is SetNull so the project itself survives.
  accountableId: z.string().nullable(),
  accountableName: z.string().nullable(),
  name: z.string(),
  description: z.string().nullable(),
  status: projectStatusEnum,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type CreateProjectBody = z.infer<typeof createProjectBody>;
export type UpdateProjectBody = z.infer<typeof updateProjectBody>;

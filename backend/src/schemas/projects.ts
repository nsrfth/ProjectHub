import { z } from 'zod';

export const projectStatusEnum = z.enum(['ACTIVE', 'ARCHIVED', 'ON_HOLD']);

export const createProjectBody = z.object({
  name: z.string().min(1).max(120).trim(),
  description: z.string().max(2000).trim().optional(),
});

export const updateProjectBody = z
  .object({
    name: z.string().min(1).max(120).trim().optional(),
    description: z.string().max(2000).trim().nullable().optional(),
    status: projectStatusEnum.optional(),
  })
  .refine(
    (v) => v.name !== undefined || v.description !== undefined || v.status !== undefined,
    'Provide at least one field to update',
  );

export const projectResponse = z.object({
  id: z.string(),
  teamId: z.string(),
  ownerId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: projectStatusEnum,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type CreateProjectBody = z.infer<typeof createProjectBody>;
export type UpdateProjectBody = z.infer<typeof updateProjectBody>;

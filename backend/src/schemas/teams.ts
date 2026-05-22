import { z } from 'zod';

// Slugs go in URLs and are unique. Restrict to lowercase letters, digits, and
// hyphens; reject leading/trailing/double hyphens. 3–60 chars is plenty for a
// team identifier and short enough for clean URLs.
export const slugSchema = z
  .string()
  .min(3)
  .max(60)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Slug must be lowercase letters/digits separated by single hyphens');

export const createTeamBody = z.object({
  name: z.string().min(1).max(120).trim(),
  slug: slugSchema,
});

export const updateTeamBody = z.object({
  name: z.string().min(1).max(120).trim().optional(),
  slug: slugSchema.optional(),
});

export const addMemberBody = z.object({
  email: z.string().email().toLowerCase(),
  role: z.enum(['MANAGER', 'MEMBER']).default('MEMBER'),
});

export const updateMemberRoleBody = z.object({
  role: z.enum(['MANAGER', 'MEMBER']),
});

export const teamIdParams = z.object({ teamId: z.string().min(1) });
export const teamMemberParams = z.object({ teamId: z.string().min(1), userId: z.string().min(1) });

export const teamResponse = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  createdAt: z.string(),
  myRole: z.enum(['MANAGER', 'MEMBER']),
});

export const teamMemberResponse = z.object({
  userId: z.string(),
  email: z.string().email(),
  name: z.string(),
  role: z.enum(['MANAGER', 'MEMBER']),
  joinedAt: z.string(),
});

export const teamDetailResponse = teamResponse.extend({
  members: z.array(teamMemberResponse),
});

export type CreateTeamBody = z.infer<typeof createTeamBody>;
export type UpdateTeamBody = z.infer<typeof updateTeamBody>;
export type AddMemberBody = z.infer<typeof addMemberBody>;
export type UpdateMemberRoleBody = z.infer<typeof updateMemberRoleBody>;

import { z } from 'zod';

// Slugs go in URLs and are unique. Restrict to lowercase letters, digits, and
// hyphens; reject leading/trailing/double hyphens. 3–60 chars is plenty for a
// team identifier and short enough for clean URLs.
export const slugSchema = z
  .string()
  .min(3)
  .max(60)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Slug must be lowercase letters/digits separated by single hyphens');

// v1.12: 7-char hex (#RRGGBB) — strict so we don't render arbitrary
// strings into a CSS background-color and confuse the parser. Null
// means "use the default slate accent" (handled by the frontend).
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Hex colour like #3b82f6');

export const createTeamBody = z.object({
  name: z.string().min(1).max(120).trim(),
  slug: slugSchema,
  color: hexColor.optional(),
});

export const updateTeamBody = z.object({
  name: z.string().min(1).max(120).trim().optional(),
  slug: slugSchema.optional(),
  // Accept `null` to explicitly clear the colour.
  color: hexColor.nullable().optional(),
});

export const addMemberBody = z.object({
  email: z.string().email().toLowerCase(),
  role: z.enum(['MANAGER', 'MEMBER']).default('MEMBER'),
});

// v1.23: PATCH /:teamId/members/:userId accepts either the legacy `role`
// enum (kept for one release for backwards-compat API callers) OR the new
// `roleId` pointing at a custom Role row. Service rejects both supplied,
// or neither.
export const updateMemberRoleBody = z
  .object({
    role: z.enum(['MANAGER', 'MEMBER']).optional(),
    roleId: z.string().min(1).optional(),
  })
  .refine(
    (v) => (v.role !== undefined) !== (v.roleId !== undefined),
    'Provide exactly one of `role` or `roleId`',
  );

export const teamIdParams = z.object({ teamId: z.string().min(1) });
export const teamMemberParams = z.object({ teamId: z.string().min(1), userId: z.string().min(1) });

export const teamResponse = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  color: z.string().nullable(),
  createdAt: z.string(),
  myRole: z.enum(['MANAGER', 'MEMBER']),
});

export const teamMemberResponse = z.object({
  userId: z.string(),
  email: z.string().email(),
  name: z.string(),
  role: z.enum(['MANAGER', 'MEMBER']),
  // v1.23: roleId + roleName surfaced so the UI can render the custom-role
  // dropdown without a second round-trip. Nullable for rows that still rely
  // on the legacy `role` enum fallback (rare; only during migration).
  roleId: z.string().nullable().default(null),
  roleName: z.string().nullable().default(null),
  joinedAt: z.string(),
});

export const teamDetailResponse = teamResponse.extend({
  members: z.array(teamMemberResponse),
});

export type CreateTeamBody = z.infer<typeof createTeamBody>;
export type UpdateTeamBody = z.infer<typeof updateTeamBody>;
export type AddMemberBody = z.infer<typeof addMemberBody>;
export type UpdateMemberRoleBody = z.infer<typeof updateMemberRoleBody>;

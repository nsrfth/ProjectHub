import { z } from 'zod';

import { currencyEnum } from './currency.js';

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
  // v1.59: team default for new project budget currency.
  defaultCurrency: currencyEnum.optional(),
});

export const addMemberBody = z
  .object({
    email: z.string().email().toLowerCase().optional(),
    userId: z.string().min(1).optional(),
    role: z.enum(['MANAGER', 'MEMBER']).default('MEMBER'),
  })
  .refine(
    (v) => (v.email !== undefined) !== (v.userId !== undefined),
    'Provide exactly one of `email` or `userId`',
  );

export const teamUserSearchQuery = z.object({
  q: z.string().default(''),
});

export const teamUserSearchHit = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  alreadyMember: z.boolean(),
});

export const teamUserSearchResponse = z.object({
  items: z.array(teamUserSearchHit),
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
  defaultCurrency: currencyEnum,
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
  disabled: z.boolean(),
  locked: z.boolean(),
  external: z.boolean(),
  groupAccessLevel: z.enum(['FULL', 'READONLY']).nullable(),
  // v2.11: the member's department (UNIT group) in this division.
  unitId: z.string().nullable(),
  unitName: z.string().nullable(),
  unitRole: z.enum(['MANAGER', 'MEMBER']).nullable(),
});

export const teamDeleteBlockersResponse = z.object({
  canDelete: z.boolean(),
  projectCount: z.number().int(),
  taskCount: z.number().int(),
  memberCount: z.number().int(),
  reasons: z.array(z.string()),
});

export const teamCapabilitiesResponse = z.object({
  editDetails: z.boolean(),
  deleteTeam: z.boolean(),
  manageGroups: z.boolean(),
  manageCustomFields: z.boolean(),
  manageAutomations: z.boolean(),
  manageForms: z.boolean(),
  // v1.95 (PMIS R0): pre-exposed profile-management capability (inert until R2).
  manageProfiles: z.boolean(),
});

export const teamDetailResponse = teamResponse.extend({
  members: z.array(teamMemberResponse),
  capabilities: teamCapabilitiesResponse,
  deleteBlockers: teamDeleteBlockersResponse.nullable(),
});

export const teamMemberKindEnum = z.enum(['member', 'external', 'all']);
export const teamMemberStatusEnum = z.enum(['active', 'disabled', 'locked']);
export const teamMemberSortByEnum = z.enum(['name', 'email', 'joinedAt', 'role']);
export const teamMemberSortDirEnum = z.enum(['asc', 'desc']);
export const teamRoleEnum = z.enum(['MANAGER', 'MEMBER']);

function clampTeamMembersPageSize(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 25;
  return Math.min(100, Math.max(10, v));
}

export const listTeamMembersQuery = z.object({
  page: z.coerce.number().int().transform((p) => Math.max(1, p)).default(1),
  pageSize: z.coerce.number().int().transform(clampTeamMembersPageSize).default(25),
  search: z.string().optional(),
  role: teamRoleEnum.optional(),
  status: teamMemberStatusEnum.optional(),
  kind: teamMemberKindEnum.default('all'),
  sortBy: teamMemberSortByEnum.default('joinedAt'),
  sortDir: teamMemberSortDirEnum.default('asc'),
});

export type ListTeamMembersQuery = z.infer<typeof listTeamMembersQuery>;

export const teamMembersPage = z.object({
  items: z.array(teamMemberResponse),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  totalItems: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative(),
});

export const memberRemovalProjectRef = z.object({
  id: z.string(),
  name: z.string(),
});

export const memberRemovalBlockersResponse = z.object({
  canRemove: z.boolean(),
  ownedProjectCount: z.number().int().nonnegative(),
  accountableProjectCount: z.number().int().nonnegative(),
  ownedProjects: z.array(memberRemovalProjectRef),
  accountableProjects: z.array(memberRemovalProjectRef),
  reasons: z.array(z.string()),
});

export const removeMemberBody = z.object({
  reassignOwnerTo: z.string().min(1).optional(),
  force: z.boolean().optional(),
});

export type RemoveMemberBody = z.infer<typeof removeMemberBody>;

export type CreateTeamBody = z.infer<typeof createTeamBody>;
export type UpdateTeamBody = z.infer<typeof updateTeamBody>;
export type AddMemberBody = z.infer<typeof addMemberBody>;
export type UpdateMemberRoleBody = z.infer<typeof updateMemberRoleBody>;

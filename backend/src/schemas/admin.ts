import { z } from 'zod';
import { passwordInputSchema } from './auth.js';

export const globalRoleEnum = z.enum(['ADMIN', 'MEMBER']);

export const updateUserRoleBody = z.object({
  globalRole: globalRoleEnum,
});

// Cursor pagination — used by GET /admin/teams. Clients pass the last id
// from the previous page back in via `?cursor=…`.
export const listQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).default(25),
});

export type ListQuery = z.infer<typeof listQuery>;

export const authSourceEnum = z.enum(['LOCAL', 'LDAP', 'SCIM']);

export const userStatusFilterEnum = z.enum(['active', 'disabled', 'locked']);
export const userSortByEnum = z.enum(['name', 'email', 'createdAt', 'lastSynced']);
export const sortDirEnum = z.enum(['asc', 'desc']);

function clampUserPageSize(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 25;
  return Math.min(100, Math.max(10, v));
}

// Offset pagination + filters for GET /admin/users (v1.52).
export const listUsersQuery = z.object({
  page: z.coerce.number().int().transform((p) => Math.max(1, p)).default(1),
  pageSize: z.coerce.number().int().transform(clampUserPageSize).default(25),
  search: z.string().optional(),
  role: globalRoleEnum.optional(),
  authSource: authSourceEnum.optional(),
  status: userStatusFilterEnum.optional(),
  directoryId: z.string().optional(),
  sortBy: userSortByEnum.default('createdAt'),
  sortDir: sortDirEnum.default('asc'),
});

export type ListUsersQuery = z.infer<typeof listUsersQuery>;

export const adminUserResponse = z.object({
  id: z.string(),
  email: z.string().email(),
  name: z.string(),
  globalRole: globalRoleEnum,
  emailVerifiedAt: z.string().nullable(),
  createdAt: z.string(),
  membershipCount: z.number().int().nonnegative(),
  directoryId: z.string().nullable().default(null),
  authSource: authSourceEnum,
  ldapUsername: z.string().nullable(),
  userPrincipalName: z.string().nullable(),
  department: z.string().nullable(),
  jobTitle: z.string().nullable(),
  managerName: z.string().nullable(),
  ldapSyncedAt: z.string().nullable(),
  directoryName: z.string().nullable(),
  directoryActive: z.boolean(),
  disabledAt: z.string().nullable(),
  lockedUntil: z.string().nullable(),
});

export const usersPage = z.object({
  items: z.array(adminUserResponse),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  totalItems: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative(),
});

export const adminTeamResponse = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  createdAt: z.string(),
  memberCount: z.number().int().nonnegative(),
  projectCount: z.number().int().nonnegative(),
});

export const teamsPage = z.object({
  items: z.array(adminTeamResponse),
  nextCursor: z.string().nullable(),
});

// v1.26: admin-driven user provisioning. Admin types email + name and either
// a password OR omits it to have the server generate one. The response
// surfaces the generated password ONCE so the admin can hand it off; nothing
// is logged.
export const createUserBody = z.object({
  email: z.string().email().max(254).toLowerCase(),
  name: z.string().min(1).max(120).trim(),
  // Same policy as self-register (min 12 chars, letters + digits). When
  // omitted, the service generates a random 20-char string and returns it.
  password: passwordInputSchema.optional(),
  globalRole: globalRoleEnum.default('MEMBER'),
  // Skip the email-verification flow for admin-provisioned accounts — the
  // admin vouches for the address. Override to false if you want them to
  // confirm via the verification token first.
  emailVerified: z.boolean().default(true),
});

export type CreateUserBody = z.infer<typeof createUserBody>;

export const createUserResponse = z.object({
  user: adminUserResponse,
  // Present only when the admin let the server generate a password. Echoed
  // back exactly once — there's no way to retrieve it later.
  generatedPassword: z.string().nullable(),
});

// v1.32.0: admin-initiated password reset. Body mirrors createUser's
// password handling: caller-supplied wins, omit for a server-generated
// 20-char value returned ONCE.
export const adminResetPasswordBody = z.object({
  password: passwordInputSchema.optional(),
});

export const adminResetPasswordResponse = z.object({
  generatedPassword: z.string().nullable(),
});

export type AdminResetPasswordBody = z.infer<typeof adminResetPasswordBody>;

export const ldapTestAuthBody = z.object({
  password: z.string().min(1).max(256),
});

export type LdapTestAuthBody = z.infer<typeof ldapTestAuthBody>;

export const ldapSyncResponse = adminUserResponse;

export const ldapTestAuthResponse = z.object({
  ok: z.literal(true),
});

export const setUserDisabledBody = z.object({
  disabled: z.boolean(),
});

export type SetUserDisabledBody = z.infer<typeof setUserDisabledBody>;

export const updateUserProfileBody = z.object({
  name: z.string().min(1).max(120).trim().optional(),
  email: z.string().email().max(254).toLowerCase().optional(),
  department: z.string().max(120).trim().nullable().optional(),
  jobTitle: z.string().max(120).trim().nullable().optional(),
});

export type UpdateUserProfileBody = z.infer<typeof updateUserProfileBody>;

// v2.19: department administration (Settings → Admin). A project's "department"
// is a ProjectAccessGrant with subjectType=GROUP whose group is a UNIT.
export const departmentRow = z.object({
  id: z.string(),
  name: z.string(),
  teamId: z.string(),
  teamName: z.string(),
  memberCount: z.number().int().nonnegative(),
});
export const departmentsList = z.array(departmentRow);

export const projectDepartmentRow = z.object({
  projectId: z.string(),
  projectName: z.string(),
  teamId: z.string(),
  teamName: z.string(),
  department: z.object({ id: z.string(), name: z.string() }).nullable(),
});
export const projectDepartmentsList = z.array(projectDepartmentRow);

export const transferDepartmentBody = z.object({
  toGroupId: z.string().min(1),
});
export type TransferDepartmentBody = z.infer<typeof transferDepartmentBody>;

export const transferDepartmentResult = z.object({
  projectId: z.string(),
  projectName: z.string(),
  from: z.object({ id: z.string(), name: z.string() }).nullable(),
  to: z.object({ id: z.string(), name: z.string() }),
  grantsMoved: z.number().int().nonnegative(),
});

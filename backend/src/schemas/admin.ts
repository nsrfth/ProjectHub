import { z } from 'zod';
import { passwordSchema } from './auth.js';

export const globalRoleEnum = z.enum(['ADMIN', 'MEMBER']);

export const updateUserRoleBody = z.object({
  globalRole: globalRoleEnum,
});

// Cursor pagination — clients pass the last id from the previous page back
// in via `?cursor=…`. `limit` is capped to keep responses fast.
export const listQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).default(25),
});

export type ListQuery = z.infer<typeof listQuery>;

export const authSourceEnum = z.enum(['LOCAL', 'LDAP', 'SCIM']);

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
});

// Paginated envelopes — `nextCursor` is null when there's no more data.
export const usersPage = z.object({
  items: z.array(adminUserResponse),
  nextCursor: z.string().nullable(),
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
  password: passwordSchema.optional(),
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
  password: passwordSchema.optional(),
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

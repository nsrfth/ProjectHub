import { z } from 'zod';

export const globalRoleEnum = z.enum(['ADMIN', 'MEMBER']);

export const updateUserRoleBody = z.object({
  globalRole: globalRoleEnum,
});

export const adminUserResponse = z.object({
  id: z.string(),
  email: z.string().email(),
  name: z.string(),
  globalRole: globalRoleEnum,
  emailVerifiedAt: z.string().nullable(),
  createdAt: z.string(),
  membershipCount: z.number().int().nonnegative(),
});

export const adminTeamResponse = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  createdAt: z.string(),
  memberCount: z.number().int().nonnegative(),
  projectCount: z.number().int().nonnegative(),
});

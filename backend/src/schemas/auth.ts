import { z } from 'zod';

// Password policy: min 12 chars, must contain at least one letter and one digit.
// Keep it strict but not annoying — long random passphrases pass easily.
export const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(200)
  .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), {
    message: 'Password must contain letters and digits',
  });

export const registerBody = z.object({
  email: z.string().email().max(254).toLowerCase(),
  name: z.string().min(1).max(120).trim(),
  password: passwordSchema,
});

export const loginBody = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(1).max(200),
});

export const requestResetBody = z.object({
  email: z.string().email().toLowerCase(),
});

export const performResetBody = z.object({
  token: z.string().min(32).max(256),
  password: passwordSchema,
});

export const verificationRequestBody = z.object({
  email: z.string().email().toLowerCase(),
});

export const verificationPerformBody = z.object({
  token: z.string().min(32).max(256),
});

export const userResponse = z.object({
  id: z.string(),
  email: z.string().email(),
  name: z.string(),
  globalRole: z.enum(['ADMIN', 'MEMBER']),
  // Phase 2A: set when the user is owned by an external directory; null for
  // local-password users. The frontend uses this to disable "change password"
  // for LDAP-managed accounts.
  directoryId: z.string().nullable().default(null),
  externalId: z.string().nullable().default(null),
  createdAt: z.string(),
});

export const authTokensResponse = z.object({
  accessToken: z.string(),
  user: userResponse,
});

export type RegisterBody = z.infer<typeof registerBody>;
export type LoginBody = z.infer<typeof loginBody>;
export type RequestResetBody = z.infer<typeof requestResetBody>;
export type PerformResetBody = z.infer<typeof performResetBody>;
export type VerificationRequestBody = z.infer<typeof verificationRequestBody>;
export type VerificationPerformBody = z.infer<typeof verificationPerformBody>;

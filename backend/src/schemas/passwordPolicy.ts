import { z } from 'zod';

export const passwordPolicyBody = z.object({
  minLength: z.number().int().min(6).max(128),
  requireUppercase: z.boolean(),
  requireLowercase: z.boolean(),
  requireNumbers: z.boolean(),
  requireSpecialChars: z.boolean(),
  passwordExpirationDays: z.number().int().min(0).max(3650),
  passwordHistoryCount: z.number().int().min(0).max(24),
  minPasswordAgeDays: z.number().int().min(0).max(365),
  maxFailedLoginAttempts: z.number().int().min(0).max(100),
  lockoutDurationMinutes: z.number().int().min(1).max(1440),
  preventCommonPasswords: z.boolean(),
  preventUsernameInPassword: z.boolean(),
});

export const passwordPolicyResponse = passwordPolicyBody;

export const publicPasswordPolicyResponse = z.object({
  policy: passwordPolicyResponse,
  requirements: z.array(z.string()),
});

export type PasswordPolicyBody = z.infer<typeof passwordPolicyBody>;

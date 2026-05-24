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
  // Phase 2C: surfaced so the Settings → Security page can render the
  // correct "enable" vs "disable" affordance without a second round-trip.
  totpEnabled: z.boolean().default(false),
  // v1.10: display calendar preference. Read on login + mirrored to
  // localStorage so the date helpers / pickers pick it up on next paint.
  calendarPreference: z.enum(['SHAMSI', 'GREGORIAN']).default('SHAMSI'),
  createdAt: z.string(),
});

// v1.10 preference patch — currently only `calendar`. Kept as its own
// object so future per-user preferences (timezone, density, language)
// land here without churning the URL.
export const updatePreferencesBody = z.object({
  calendar: z.enum(['SHAMSI', 'GREGORIAN']).optional(),
});

export type UpdatePreferencesBody = z.infer<typeof updatePreferencesBody>;

export const authTokensResponse = z.object({
  accessToken: z.string(),
  user: userResponse,
});

// ── Two-factor authentication ─────────────────────────────────────────────
// Setup response — secret + QR exposed exactly once at enrolment.
export const twoFactorSetupResponse = z.object({
  secret: z.string(),
  uri: z.string(),
  qrDataUrl: z.string(),
});

export const twoFactorConfirmBody = z.object({
  secret: z.string().min(8).max(128),
  code: z.string().regex(/^\d{6}$/, '6-digit numeric'),
});

// Surfaced ONCE, immediately after confirmSetup or regenerate. Never again.
export const twoFactorRecoveryCodesResponse = z.object({
  recoveryCodes: z.array(z.string()),
});

export const twoFactorDisableBody = z.object({
  // Either a 6-digit TOTP code or a recovery code. Length-vary; checked
  // server-side.
  code: z.string().min(4).max(40),
});

// Second-step login. `pendingToken` came from the 200 response of /login
// when 2FA is enabled; `code` is the user's TOTP or recovery code.
export const twoFactorLoginBody = z.object({
  pendingToken: z.string().min(20).max(2048),
  code: z.string().min(4).max(40),
});

export const twoFactorPendingResponse = z.object({
  pending2fa: z.literal(true),
  pendingToken: z.string(),
});

export type RegisterBody = z.infer<typeof registerBody>;
export type LoginBody = z.infer<typeof loginBody>;
export type RequestResetBody = z.infer<typeof requestResetBody>;
export type PerformResetBody = z.infer<typeof performResetBody>;
export type VerificationRequestBody = z.infer<typeof verificationRequestBody>;
export type VerificationPerformBody = z.infer<typeof verificationPerformBody>;

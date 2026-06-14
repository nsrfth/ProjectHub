import { z } from 'zod';

import { themePreferenceEnum } from './themePreference.js';

// Route-level shape only — full policy enforced in PasswordPolicyService.
export const passwordInputSchema = z.string().min(1).max(200);

/** @deprecated Use passwordInputSchema + PasswordPolicyService.assertValid */
export const passwordSchema = passwordInputSchema;

// v1.30.11 (S-9): registerBody removed alongside the public
// /auth/register route. Admin-driven user creation uses the schemas
// in schemas/admin.ts (createUserBody).

export const loginBody = z.object({
  // Accepts email or LDAP username (sAMAccountName). Lowercased for lookup.
  email: z.string().min(1).max(254).transform((s) => s.trim().toLowerCase()),
  password: z.string().min(1).max(200),
});

export const requestResetBody = z.object({
  email: z.string().email().toLowerCase(),
});

export const performResetBody = z.object({
  token: z.string().min(32).max(256),
  password: passwordInputSchema,
});

// v1.32.0: user-initiated password change. Verifies `currentPassword`
// against the user's stored hash, then rotates to `newPassword`. We only
// validate `currentPassword` length here (full policy doesn't apply — it's
// whatever they currently have); `newPassword` runs the regular policy.
export const changeOwnPasswordBody = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: passwordInputSchema,
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
  authSource: z.enum(['LOCAL', 'LDAP', 'SCIM']).default('LOCAL'),
  // Phase 2C: surfaced so the Settings → Security page can render the
  // correct "enable" vs "disable" affordance without a second round-trip.
  totpEnabled: z.boolean().default(false),
  // v1.10: display calendar preference. Read on login + mirrored to
  // localStorage so the date helpers / pickers pick it up on next paint.
  calendarPreference: z.enum(['SHAMSI', 'GREGORIAN']).default('SHAMSI'),
  // v1.13: per-user theme + UI language. Mirrored to localStorage at
  // every signed-in entry point so a user changing their pref on one
  // device sees it on another after login.
  themePreference: themePreferenceEnum.default('LIGHT'),
  languagePreference: z.enum(['EN', 'FA']).default('EN'),
  createdAt: z.string(),
});

// v1.10/v1.13 preference patch. PATCH semantics — any omitted field is
// left as-is. New per-user toggles add a field here without an URL change.
export const updatePreferencesBody = z.object({
  calendar: z.enum(['SHAMSI', 'GREGORIAN']).optional(),
  theme: themePreferenceEnum.optional(),
  language: z.enum(['EN', 'FA']).optional(),
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

export type LoginBody = z.infer<typeof loginBody>;
export type RequestResetBody = z.infer<typeof requestResetBody>;
export type PerformResetBody = z.infer<typeof performResetBody>;
export type VerificationRequestBody = z.infer<typeof verificationRequestBody>;
export type VerificationPerformBody = z.infer<typeof verificationPerformBody>;
export type ChangeOwnPasswordBody = z.infer<typeof changeOwnPasswordBody>;

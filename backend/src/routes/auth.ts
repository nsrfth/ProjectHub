import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AuthController } from '../controllers/authController.js';
import { AuthService } from '../services/authService.js';
import {
  changeOwnPasswordBody,
  loginBody,
  performResetBody,
  requestResetBody,
  twoFactorConfirmBody,
  twoFactorDisableBody,
  twoFactorLoginBody,
  twoFactorRecoveryCodesResponse,
  twoFactorSetupResponse,
  verificationPerformBody,
  verificationRequestBody,
} from '../schemas/auth.js';
import { themePreferenceEnum } from '../schemas/themePreference.js';
// v1.30.11 (S-9): public self-registration was removed because the
// "Email already registered" 409 was an account-enumeration channel.
// New accounts come from `prisma db seed` (first admin) and the v1.26
// POST /api/admin/users endpoint (everyone else). `registerBody` is
// no longer imported here because the route is gone.
import { requireAuth } from '../middleware/auth.js';
import { requireSessionAuth } from '../middleware/requireScope.js';
import type { Env } from '../config/env.js';

export async function authRoutes(app: FastifyInstance, opts: { env: Env }): Promise<void> {
  const env = opts.env;
  // Rate-limit applied to write-side auth endpoints. Read from env so tests
  // can crank it up without hitting the limiter; in prod the .env default of
  // 10/min/IP is what we want.
  const RL_TAG = {
    rateLimit: { max: env.AUTH_RATE_LIMIT_MAX, timeWindow: env.AUTH_RATE_LIMIT_WINDOW },
  } as const;
  const svc = new AuthService(env, {
    signAccess: (p) => app.signAccess(p as any),
    signRefresh: (p, exp) => app.signRefresh(p, exp),
    verifyRefresh: (t) => app.verifyRefresh(t),
    signPending: (sub) => app.signPending(sub),
    verifyPending: (t) => app.verifyPending(t),
  });
  const ctrl = new AuthController(env, svc);

  const r = app.withTypeProvider<ZodTypeProvider>();

  // v1.30.11 (S-9): POST /register removed — public self-registration
  // leaked whether an email was registered ("Email already registered"
  // 409 vs "OK" 201). Bootstrap is now exclusively the prisma seed
  // (SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD); subsequent users come
  // through POST /api/admin/users (v1.26).

  r.post('/login', {
    config: RL_TAG,
    schema: {
      tags: ['auth'],
      summary: 'Log in with email + password (may return a pending-2FA challenge)',
      body: loginBody,
      // Response is either the full session OR `{ pending2fa: true,
      // pendingToken }`. z.any() lets both shapes pass — the frontend
      // dispatches on the presence of `pending2fa`.
      response: { 200: z.any() },
    },
    handler: ctrl.login,
  });

  r.post('/refresh', {
    config: RL_TAG,
    schema: { tags: ['auth'], summary: 'Rotate refresh token, return new access token' },
    handler: ctrl.refresh,
  });

  r.post('/logout', {
    schema: { tags: ['auth'], summary: 'Revoke the current refresh token' },
    handler: ctrl.logout,
  });

  r.post('/password/reset-request', {
    config: RL_TAG,
    schema: { tags: ['auth'], summary: 'Begin password reset', body: requestResetBody },
    handler: ctrl.requestReset,
  });

  r.post('/password/reset', {
    config: RL_TAG,
    schema: { tags: ['auth'], summary: 'Complete password reset', body: performResetBody },
    handler: ctrl.performReset,
  });

  r.post('/verification/request', {
    config: RL_TAG,
    schema: {
      tags: ['auth'],
      summary: 'Re-issue an email verification token (anti-enumeration response)',
      body: verificationRequestBody,
    },
    handler: ctrl.requestVerification,
  });

  r.post('/verification/perform', {
    config: RL_TAG,
    schema: {
      tags: ['auth'],
      summary: 'Claim a verification token; marks the user as email-verified',
      body: verificationPerformBody,
    },
    handler: ctrl.performVerification,
  });

  r.get('/me', {
    preHandler: requireAuth,
    schema: { tags: ['auth'], summary: 'Get the current user', security: [{ bearerAuth: [] }] },
    handler: ctrl.me,
  });

  r.post('/me/password', {
    // v1.32.0: session-only — rotating your own password via a long-lived
    // API token would let a stolen `*`-scoped token quietly lock the
    // legitimate owner out. Same shape as 2FA management.
    preHandler: [requireAuth, requireSessionAuth],
    config: RL_TAG,
    schema: {
      tags: ['auth'],
      summary:
        'Change own password (verifies current password; revokes other-device refresh tokens)',
      body: changeOwnPasswordBody,
      response: { 204: z.null() },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.changeOwnPassword,
  });

  r.patch('/me/preferences', {
    // v1.30.3 (S-2): identity-affecting; no API token (even `*`-scoped)
    // should rewrite a user's display preferences.
    preHandler: [requireAuth, requireSessionAuth],
    schema: {
      tags: ['auth'],
      summary: 'Update per-user preferences (calendar, theme, language)',
      body: z.object({
        calendar: z.enum(['SHAMSI', 'GREGORIAN']).optional(),
        theme: themePreferenceEnum.optional(),
        language: z.enum(['EN', 'FA']).optional(),
      }),
      response: {
        200: z.object({
          calendar: z.enum(['SHAMSI', 'GREGORIAN']),
          theme: themePreferenceEnum,
          language: z.enum(['EN', 'FA']),
        }),
      },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.updatePreferences,
  });

  // ── 2FA endpoints ────────────────────────────────────────────────────
  r.post('/2fa/login', {
    config: RL_TAG,
    schema: {
      tags: ['auth'],
      summary: 'Complete login with a TOTP / recovery code after /login returned pending2fa',
      body: twoFactorLoginBody,
      response: { 200: z.object({ accessToken: z.string(), user: z.any() }) },
    },
    handler: ctrl.twoFactorLogin,
  });

  r.post('/2fa/setup', {
    // v1.30.3 (S-2): 2FA management is session-only. A wildcard API token
    // must NEVER be able to disable a user's second factor — that's the
    // exact attack chain S-3 patched the pending-token side of.
    preHandler: [requireAuth, requireSessionAuth],
    schema: {
      tags: ['auth'],
      summary: 'Begin 2FA enrolment — returns secret + QR (nothing persisted yet)',
      response: { 200: twoFactorSetupResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.twoFactorSetup,
  });

  r.post('/2fa/confirm', {
    preHandler: [requireAuth, requireSessionAuth],
    schema: {
      tags: ['auth'],
      summary: 'Finalise 2FA enrolment — verify a code, then persist + return recovery codes once',
      body: twoFactorConfirmBody,
      response: { 200: twoFactorRecoveryCodesResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.twoFactorConfirm,
  });

  r.post('/2fa/disable', {
    preHandler: [requireAuth, requireSessionAuth],
    schema: {
      tags: ['auth'],
      summary: 'Disable 2FA — requires a fresh TOTP / recovery proof',
      body: twoFactorDisableBody,
      response: { 204: z.null() },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.twoFactorDisable,
  });

  r.post('/2fa/recovery-codes', {
    preHandler: [requireAuth, requireSessionAuth],
    schema: {
      tags: ['auth'],
      summary: 'Regenerate recovery codes (invalidates the previous set)',
      response: { 200: twoFactorRecoveryCodesResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.twoFactorRegenerateCodes,
  });
}

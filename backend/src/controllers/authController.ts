import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Env } from '../config/env.js';
import { AuthService } from '../services/authService.js';
import type {
  ChangeOwnPasswordBody,
  LoginBody,
  PerformResetBody,
  RequestResetBody,
  VerificationPerformBody,
  VerificationRequestBody,
} from '../schemas/auth.js';
import type { ThemePreferenceValue } from '../schemas/themePreference.js';
import { Errors } from '../lib/errors.js';
import { TwoFactorService } from '../services/twoFactorService.js';

const REFRESH_COOKIE = 'th_refresh';

function setRefreshCookie(reply: FastifyReply, env: Env, token: string, expires: Date): void {
  reply.setCookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: 'lax',
    path: '/api/auth',
    domain: env.COOKIE_DOMAIN || undefined,
    expires,
  });
}

function clearRefreshCookie(reply: FastifyReply, env: Env): void {
  reply.clearCookie(REFRESH_COOKIE, {
    path: '/api/auth',
    domain: env.COOKIE_DOMAIN || undefined,
  });
}

export class AuthController {
  constructor(
    private readonly env: Env,
    private readonly svc: AuthService,
  ) {}

  // v1.30.11 (S-9): `register` handler removed alongside the route.
  // Public self-registration was an account-enumeration channel
  // ("Email already registered" 409 vs 201). The bootstrap path is
  // now the prisma seed (SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD); all
  // subsequent users come from POST /api/admin/users (v1.26).

  login = async (req: FastifyRequest<{ Body: LoginBody }>, reply: FastifyReply) => {
    const outcome = await this.svc.loginOutcome(req.body);
    if (outcome.kind === 'pending2fa') {
      // No refresh cookie yet — the full session lands only after the second
      // step. Send the pending token in the body; the frontend keeps it in
      // memory and POSTs it back to /auth/2fa/login.
      return reply.send({ pending2fa: true, pendingToken: outcome.pendingToken });
    }
    const session = outcome.session;
    setRefreshCookie(reply, this.env, session.refreshTokenRaw, session.refreshExpiresAt);
    return reply.send({
      accessToken: session.accessToken,
      user: { ...session.user, createdAt: session.user.createdAt.toISOString() },
    });
  };

  // Second step of 2FA login. Takes the pending token + TOTP/recovery code,
  // returns the full session shape that /login returns when 2FA is off.
  twoFactorLogin = async (
    req: FastifyRequest<{ Body: { pendingToken: string; code: string } }>,
    reply: FastifyReply,
  ) => {
    const session = await this.svc.completeLoginWith2fa(req.body.pendingToken, req.body.code);
    setRefreshCookie(reply, this.env, session.refreshTokenRaw, session.refreshExpiresAt);
    return reply.send({
      accessToken: session.accessToken,
      user: { ...session.user, createdAt: session.user.createdAt.toISOString() },
    });
  };

  // ── 2FA management (requires an authenticated user) ────────────────────
  private readonly twoFactor = new TwoFactorService();

  twoFactorSetup = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) throw Errors.unauthorized();
    const setup = await this.twoFactor.setup(req.user.sub);
    return reply.send(setup);
  };

  twoFactorConfirm = async (
    req: FastifyRequest<{ Body: { secret: string; code: string } }>,
    reply: FastifyReply,
  ) => {
    if (!req.user) throw Errors.unauthorized();
    const result = await this.twoFactor.confirmSetup(
      req.user.sub,
      req.body.secret,
      req.body.code,
    );
    return reply.send(result);
  };

  twoFactorDisable = async (
    req: FastifyRequest<{ Body: { code: string } }>,
    reply: FastifyReply,
  ) => {
    if (!req.user) throw Errors.unauthorized();
    await this.twoFactor.disable(req.user.sub, req.body.code);
    return reply.code(204).send();
  };

  twoFactorRegenerateCodes = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) throw Errors.unauthorized();
    const codes = await this.twoFactor.regenerateRecoveryCodes(req.user.sub);
    return reply.send({ recoveryCodes: codes });
  };

  refresh = async (req: FastifyRequest, reply: FastifyReply) => {
    const raw = req.cookies?.[REFRESH_COOKIE];
    if (!raw) throw Errors.unauthorized('Missing refresh token');
    const session = await this.svc.refresh(raw);
    setRefreshCookie(reply, this.env, session.refreshTokenRaw, session.refreshExpiresAt);
    return reply.send({
      accessToken: session.accessToken,
      user: { ...session.user, createdAt: session.user.createdAt.toISOString() },
    });
  };

  logout = async (req: FastifyRequest, reply: FastifyReply) => {
    await this.svc.logout(req.cookies?.[REFRESH_COOKIE]);
    clearRefreshCookie(reply, this.env);
    return reply.status(204).send();
  };

  requestReset = async (req: FastifyRequest<{ Body: RequestResetBody }>, reply: FastifyReply) => {
    const { resetToken } = await this.svc.requestPasswordReset(req.body.email);
    // Always return 202 + identical body so an attacker can't enumerate accounts.
    // In non-production we expose the token to make the dev/test flow possible
    // without an email provider; in production it would only ever be emailed.
    const body: Record<string, unknown> = { status: 'accepted' };
    if (this.env.NODE_ENV !== 'production' && resetToken) {
      body.devResetToken = resetToken;
    }
    return reply.status(202).send(body);
  };

  performReset = async (req: FastifyRequest<{ Body: PerformResetBody }>, reply: FastifyReply) => {
    await this.svc.performPasswordReset(req.body);
    return reply.status(204).send();
  };

  // v1.32.0: user-initiated password change. Session-only (routed with
  // requireSessionAuth) — an API token, even `*`-scoped, must not be able
  // to rotate the owner's password.
  changeOwnPassword = async (
    req: FastifyRequest<{ Body: ChangeOwnPasswordBody }>,
    reply: FastifyReply,
  ) => {
    if (!req.user) throw Errors.unauthorized();
    await this.svc.changeOwnPassword(req.user.sub, req.body);
    return reply.status(204).send();
  };

  requestVerification = async (
    req: FastifyRequest<{ Body: VerificationRequestBody }>,
    reply: FastifyReply,
  ) => {
    const { verificationToken } = await this.svc.requestEmailVerification(req.body.email);
    // Same anti-enumeration shape as password reset.
    const body: Record<string, unknown> = { status: 'accepted' };
    if (this.env.NODE_ENV !== 'production' && verificationToken) {
      body.devVerifyToken = verificationToken;
    }
    return reply.status(202).send(body);
  };

  performVerification = async (
    req: FastifyRequest<{ Body: VerificationPerformBody }>,
    reply: FastifyReply,
  ) => {
    await this.svc.performEmailVerification(req.body.token);
    return reply.status(204).send();
  };

  me = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) throw Errors.unauthorized();
    return reply.send({
      id: req.user.sub,
      email: req.user.email,
      globalRole: req.user.globalRole,
    });
  };

  // v1.10/v1.13: per-user preferences. PATCH semantics — any omitted field
  // stays as-is. Returns the new triple so the frontend can mirror to
  // localStorage without a follow-up GET.
  updatePreferences = async (
    req: FastifyRequest<{ Body: {
      calendar?: 'SHAMSI' | 'GREGORIAN';
      theme?: ThemePreferenceValue;
      language?: 'EN' | 'FA';
    } }>,
    reply: FastifyReply,
  ) => {
    if (!req.user) throw Errors.unauthorized();
    const { prisma } = await import('../data/prisma.js');
    const data: Record<string, unknown> = {};
    if (req.body.calendar) data.calendarPreference = req.body.calendar;
    if (req.body.theme) data.themePreference = req.body.theme;
    if (req.body.language) data.languagePreference = req.body.language;
    const updated = await prisma.user.update({
      where: { id: req.user.sub },
      data,
      select: {
        calendarPreference: true,
        themePreference: true,
        languagePreference: true,
      },
    });
    return reply.send({
      calendar: updated.calendarPreference,
      theme: updated.themePreference,
      language: updated.languagePreference,
    });
  };
}

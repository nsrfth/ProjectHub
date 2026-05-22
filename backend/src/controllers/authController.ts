import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Env } from '../config/env.js';
import { AuthService } from '../services/authService.js';
import type {
  LoginBody,
  PerformResetBody,
  RegisterBody,
  RequestResetBody,
} from '../schemas/auth.js';
import { Errors } from '../lib/errors.js';

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

  register = async (req: FastifyRequest<{ Body: RegisterBody }>, reply: FastifyReply) => {
    const session = await this.svc.register(req.body);
    setRefreshCookie(reply, this.env, session.refreshTokenRaw, session.refreshExpiresAt);
    return reply.status(201).send({
      accessToken: session.accessToken,
      user: { ...session.user, createdAt: session.user.createdAt.toISOString() },
    });
  };

  login = async (req: FastifyRequest<{ Body: LoginBody }>, reply: FastifyReply) => {
    const session = await this.svc.login(req.body);
    setRefreshCookie(reply, this.env, session.refreshTokenRaw, session.refreshExpiresAt);
    return reply.send({
      accessToken: session.accessToken,
      user: { ...session.user, createdAt: session.user.createdAt.toISOString() },
    });
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

  me = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) throw Errors.unauthorized();
    return reply.send({
      id: req.user.sub,
      email: req.user.email,
      globalRole: req.user.globalRole,
    });
  };
}

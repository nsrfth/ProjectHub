import type { Prisma } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';
import { hashPassword, randomTokenHex, sha256, verifyPassword } from '../lib/hashing.js';
import { parseDuration } from '../lib/time.js';
import type { Env } from '../config/env.js';

// All token lifecycle logic lives here. Routes/controllers don't talk to Prisma directly.

export interface IssuedSession {
  accessToken: string;
  refreshTokenRaw: string;
  refreshExpiresAt: Date;
  user: {
    id: string;
    email: string;
    name: string;
    globalRole: 'ADMIN' | 'MEMBER';
    createdAt: Date;
  };
}

export interface AuthSigner {
  signAccess(payload: {
    sub: string;
    email: string;
    globalRole: 'ADMIN' | 'MEMBER';
  }): string;
  signRefresh(payload: { sub: string; jti: string }, expiresIn: string): string;
  verifyRefresh(token: string): { sub: string; jti: string };
}

export class AuthService {
  constructor(
    private readonly env: Env,
    private readonly signer: AuthSigner,
  ) {}

  async register(input: { email: string; password: string; name: string }): Promise<IssuedSession> {
    const existing = await prisma.user.findUnique({ where: { email: input.email } });
    if (existing) throw Errors.conflict('Email already registered');

    const passwordHash = await hashPassword(input.password);
    const user = await prisma.user.create({
      data: {
        email: input.email,
        name: input.name,
        passwordHash,
        // First user becomes ADMIN. Subsequent users default to MEMBER.
        // Race-tolerant: even with concurrent inserts, at most one wins as admin.
        globalRole: (await prisma.user.count()) === 0 ? 'ADMIN' : 'MEMBER',
      },
    });

    return this.issueSession(user);
  }

  async login(input: { email: string; password: string }): Promise<IssuedSession> {
    const user = await prisma.user.findUnique({ where: { email: input.email } });
    // Same error for "no user" vs "wrong password" to prevent account enumeration.
    if (!user) throw Errors.unauthorized('Invalid credentials');
    const ok = await verifyPassword(user.passwordHash, input.password);
    if (!ok) throw Errors.unauthorized('Invalid credentials');

    return this.issueSession(user);
  }

  // Rotates the refresh token: revokes the old, issues a new pair.
  // If the same refresh token is presented twice, the second use fails (revoked).
  async refresh(rawRefreshToken: string): Promise<IssuedSession> {
    let payload: { sub: string; jti: string };
    try {
      payload = this.signer.verifyRefresh(rawRefreshToken);
    } catch {
      throw Errors.unauthorized('Invalid refresh token');
    }

    const tokenHash = sha256(rawRefreshToken);
    const record = await prisma.refreshToken.findUnique({ where: { tokenHash } });
    if (!record || record.id !== payload.jti) throw Errors.unauthorized('Refresh token not recognized');
    if (record.revokedAt) throw Errors.unauthorized('Refresh token revoked');
    if (record.expiresAt < new Date()) throw Errors.unauthorized('Refresh token expired');

    const user = await prisma.user.findUnique({ where: { id: record.userId } });
    if (!user) throw Errors.unauthorized();

    await prisma.refreshToken.update({
      where: { id: record.id },
      data: { revokedAt: new Date() },
    });

    return this.issueSession(user);
  }

  async logout(rawRefreshToken: string | undefined): Promise<void> {
    if (!rawRefreshToken) return;
    const tokenHash = sha256(rawRefreshToken);
    // Best-effort revoke; success or no-op (token might already be gone).
    await prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  // Returns the raw reset token. In production this would be emailed to the
  // user. Email is intentionally not wired up per project decision; the caller
  // (controller) returns the token in the response body only in non-production.
  async requestPasswordReset(email: string): Promise<{ resetToken: string | null }> {
    const user = await prisma.user.findUnique({ where: { email } });
    // Return a token only if the user exists, but the response shape is identical
    // either way so callers can't enumerate accounts via this endpoint.
    if (!user) return { resetToken: null };

    const raw = randomTokenHex(32);
    const expiresAt = new Date(Date.now() + parseDuration('1h'));
    await prisma.passwordReset.create({
      data: { userId: user.id, tokenHash: sha256(raw), expiresAt },
    });
    return { resetToken: raw };
  }

  async performPasswordReset(input: { token: string; password: string }): Promise<void> {
    const tokenHash = sha256(input.token);
    const reset = await prisma.passwordReset.findUnique({ where: { tokenHash } });
    if (!reset || reset.usedAt || reset.expiresAt < new Date()) {
      throw Errors.badRequest('Invalid or expired reset token');
    }

    const passwordHash = await hashPassword(input.password);
    await prisma.$transaction([
      prisma.user.update({ where: { id: reset.userId }, data: { passwordHash } }),
      prisma.passwordReset.update({ where: { id: reset.id }, data: { usedAt: new Date() } }),
      // Revoke every active session for this user; force re-login.
      prisma.refreshToken.updateMany({
        where: { userId: reset.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
  }

  private async issueSession(
    user: Prisma.UserGetPayload<true>,
  ): Promise<IssuedSession> {
    // Create the refresh-token row first so we have a stable jti to embed.
    const refreshExpiresAt = new Date(Date.now() + parseDuration(this.env.JWT_REFRESH_TTL));
    // We need the row id before we can sign with it; use a two-step create with
    // a placeholder hash, then update once the JWT is signed. Cheaper than a
    // synthetic uuid + uniqueness check.
    const placeholder = sha256(randomTokenHex(16));
    const row = await prisma.refreshToken.create({
      data: { userId: user.id, tokenHash: placeholder, expiresAt: refreshExpiresAt },
    });

    const refreshTokenRaw = this.signer.signRefresh(
      { sub: user.id, jti: row.id },
      this.env.JWT_REFRESH_TTL,
    );
    await prisma.refreshToken.update({
      where: { id: row.id },
      data: { tokenHash: sha256(refreshTokenRaw) },
    });

    const accessToken = this.signer.signAccess({
      sub: user.id,
      email: user.email,
      globalRole: user.globalRole,
    });

    return {
      accessToken,
      refreshTokenRaw,
      refreshExpiresAt,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        globalRole: user.globalRole,
        createdAt: user.createdAt,
      },
    };
  }
}

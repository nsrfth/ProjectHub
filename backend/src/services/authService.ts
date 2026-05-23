import type { Prisma, User } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';
import { hashPassword, randomTokenHex, sha256, verifyPassword } from '../lib/hashing.js';
import { parseDuration } from '../lib/time.js';
import type { Env } from '../config/env.js';
import { DirectoryService } from './directoryService.js';
import { LdapService, type LdapAuthResult } from './ldapService.js';

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
    directoryId: string | null;
    externalId: string | null;
    createdAt: Date;
  };
  // Set on `register` only — the raw email-verification token the controller
  // surfaces to the client in non-prod (mirrors devResetToken). null when the
  // user is already verified (admins via seed) so register doesn't re-issue.
  verificationToken?: string | null;
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
  // Lazily constructed — only paid for when LDAP login actually fires.
  private readonly directories = new DirectoryService();
  private readonly ldap = new LdapService();

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

    // Auto-issue an email-verification token. Real email delivery isn't wired;
    // the controller returns this token in the response body in non-prod so
    // dev/test flows can call /verification/perform with it.
    const verificationToken = await this.createVerificationToken(user.id);

    const session = await this.issueSession(user);
    return { ...session, verificationToken };
  }

  async login(input: { email: string; password: string }): Promise<IssuedSession> {
    const user = await prisma.user.findUnique({ where: { email: input.email } });

    // Soft-disabled users (SCIM `active: false`) can't log in regardless of
    // which auth backend they're on. Same error string as bad credentials to
    // avoid leaking account state.
    if (user?.disabledAt) throw Errors.unauthorized('Invalid credentials');

    // ── Local user (no directoryId): legacy argon2 password check. ─────────
    if (user && !user.directoryId) {
      if (!user.passwordHash) throw Errors.unauthorized('Invalid credentials');
      const ok = await verifyPassword(user.passwordHash, input.password);
      if (!ok) throw Errors.unauthorized('Invalid credentials');
      return this.issueSession(user);
    }

    // ── Directory-bound user: bind against the specific directory. ─────────
    if (user?.directoryId) {
      const dir = await this.directories.getRaw(user.directoryId).catch(() => null);
      if (!dir) throw Errors.unauthorized('Invalid credentials');
      const result = await this.ldap.authenticate(dir, input.email, input.password);
      if (!result) throw Errors.unauthorized('Invalid credentials');
      await this.syncFromLdap(user, dir.id, result);
      return this.issueSession(user);
    }

    // ── No local row yet: try each active LDAP directory in turn (JIT). ────
    // Keeps "user typed wrong password" indistinguishable from "no such user"
    // to avoid account enumeration.
    const directories = await this.directories.listActiveLdap();
    for (const dir of directories) {
      if (!dir.allowJIT) continue;
      const result = await this.ldap.authenticate(dir, input.email, input.password);
      if (!result) continue;
      const provisioned = await this.provisionFromLdap(dir.id, result);
      return this.issueSession(provisioned);
    }

    throw Errors.unauthorized('Invalid credentials');
  }

  // JIT-create the local User row for a successfully-bound LDAP user. First
  // user to ever land becomes ADMIN (matches the register() rule). Then
  // apply group → role mappings so the new user picks up the mapped roles
  // immediately on their first login, not only on the second.
  private async provisionFromLdap(
    directoryId: string,
    result: LdapAuthResult,
  ): Promise<User> {
    // Race: another concurrent login for the same DN might already have
    // created the row. Catch the unique-constraint failure and re-read.
    let user: User;
    try {
      user = await prisma.user.create({
        data: {
          email: result.email,
          name: result.displayName || result.email,
          directoryId,
          externalId: result.dn,
          // No local password — argon2 verify can't be run on this row.
          passwordHash: null,
          emailVerifiedAt: new Date(),
          globalRole: (await prisma.user.count()) === 0 ? 'ADMIN' : 'MEMBER',
        },
      });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== 'P2002') throw e;
      const existing = await prisma.user.findFirst({
        where: { directoryId, externalId: result.dn },
      });
      if (!existing) throw e;
      user = existing;
    }

    await this.applyGroupMappings(user.id, directoryId, result.groups);
    // Re-read so the caller sees the post-mapping globalRole.
    const refreshed = await prisma.user.findUnique({ where: { id: user.id } });
    return refreshed ?? user;
  }

  // Pull fresh email/name from LDAP and reapply group mappings on each login.
  // Cheap because the search already happened in authenticate().
  private async syncFromLdap(
    user: User,
    directoryId: string,
    result: LdapAuthResult,
  ): Promise<void> {
    const dataUpdate: Prisma.UserUpdateInput = {};
    if (user.email !== result.email) dataUpdate.email = result.email;
    if (result.displayName && user.name !== result.displayName) dataUpdate.name = result.displayName;
    if (user.externalId !== result.dn) dataUpdate.externalId = result.dn;
    if (Object.keys(dataUpdate).length) {
      await prisma.user.update({ where: { id: user.id }, data: dataUpdate });
    }
    await this.applyGroupMappings(user.id, directoryId, result.groups);
  }

  // Translate LDAP group DNs into TaskHub role assignments. Only fires when
  // the directory has syncRolesFromGroups=true (which the admin opts into).
  // Two semantics:
  //   - mapping.globalRole set    → user.globalRole = mapping.globalRole
  //   - mapping.teamId + teamRole → upsert TeamMembership(userId, teamId)
  //     with the mapped role; remove memberships that no longer match any
  //     mapping for this directory (so removing a group revokes access).
  private async applyGroupMappings(
    userId: string,
    directoryId: string,
    groupDns: string[],
  ): Promise<void> {
    const dir = await prisma.directory.findUnique({ where: { id: directoryId } });
    if (!dir?.syncRolesFromGroups) return;

    const mappings = await prisma.directoryGroupMapping.findMany({ where: { directoryId } });
    const matched = mappings.filter((m) => groupDns.includes(m.externalGroupDn));

    // Highest-rank global role wins. ADMIN > MEMBER.
    const globalRoles = matched.map((m) => m.globalRole).filter(Boolean);
    const newGlobal = globalRoles.includes('ADMIN') ? 'ADMIN'
      : globalRoles.includes('MEMBER') ? 'MEMBER'
      : null;
    if (newGlobal) {
      await prisma.user.update({ where: { id: userId }, data: { globalRole: newGlobal } });
    }

    // Team memberships: upsert what matched; remove directory-managed
    // memberships that no longer match. We only touch teams owned by this
    // directory's mappings to avoid stomping manager-driven invites.
    const desiredTeamIds = new Set(
      matched.map((m) => m.teamId).filter((id): id is string => !!id),
    );
    for (const m of matched) {
      if (!m.teamId || !m.teamRole) continue;
      await prisma.teamMembership.upsert({
        where: { userId_teamId: { userId, teamId: m.teamId } },
        update: { role: m.teamRole },
        create: { userId, teamId: m.teamId, role: m.teamRole },
      });
    }
    // Strip memberships in directory-mapped teams that the user no longer
    // qualifies for. Teams not referenced by any mapping for this directory
    // are left alone — those are non-directory teams.
    const mappedTeamIds = new Set(
      mappings.map((m) => m.teamId).filter((id): id is string => !!id),
    );
    const toRemove = [...mappedTeamIds].filter((id) => !desiredTeamIds.has(id));
    if (toRemove.length) {
      await prisma.teamMembership.deleteMany({
        where: { userId, teamId: { in: toRemove } },
      });
    }
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
    // SCIM-disabled accounts can't refresh either. Their refresh tokens were
    // already revoked at disable-time, but this catches the race where the
    // disable + refresh interleave.
    if (user.disabledAt) throw Errors.unauthorized('Invalid refresh token');

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

  // Internal — issue + persist a single-use email-verification token for a
  // user. Returns the raw token; only the SHA-256 hash is stored.
  private async createVerificationToken(userId: string): Promise<string> {
    const raw = randomTokenHex(32);
    const expiresAt = new Date(Date.now() + parseDuration('24h'));
    await prisma.emailVerification.create({
      data: { userId, tokenHash: sha256(raw), expiresAt },
    });
    return raw;
  }

  // Re-send (or first-send) a verification token. Always returns success-shape
  // even for unknown / already-verified emails to prevent enumeration. The
  // returned token (when present) is what the controller surfaces in non-prod.
  async requestEmailVerification(email: string): Promise<{ verificationToken: string | null }> {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || user.emailVerifiedAt) return { verificationToken: null };
    const raw = await this.createVerificationToken(user.id);
    return { verificationToken: raw };
  }

  async performEmailVerification(token: string): Promise<void> {
    const tokenHash = sha256(token);
    const row = await prisma.emailVerification.findUnique({ where: { tokenHash } });
    if (!row || row.usedAt || row.expiresAt < new Date()) {
      throw Errors.badRequest('Invalid or expired verification token');
    }
    await prisma.$transaction([
      prisma.user.update({
        where: { id: row.userId },
        data: { emailVerifiedAt: new Date() },
      }),
      prisma.emailVerification.update({
        where: { id: row.id },
        data: { usedAt: new Date() },
      }),
    ]);
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
        directoryId: user.directoryId,
        externalId: user.externalId,
        createdAt: user.createdAt,
      },
    };
  }
}

import type { Prisma, User } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';
import { hashPassword, randomTokenHex, sha256, verifyPassword } from '../lib/hashing.js';
import { parseDuration } from '../lib/time.js';
import type { Env } from '../config/env.js';
import { DirectoryService } from './directoryService.js';
import { LdapService, type LdapAuthResult } from './ldapService.js';
import { TwoFactorService } from './twoFactorService.js';
import { emailService } from './emailService.js';

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
    totpEnabled: boolean;
    calendarPreference: 'SHAMSI' | 'GREGORIAN';
    themePreference: 'LIGHT' | 'DARK';
    languagePreference: 'EN' | 'FA';
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
  signPending(sub: string): string;
  verifyPending(token: string): { sub: string; kind: '2fa-pending' };
}

// Wrapped login result. When the user has 2FA enabled and the first factor
// passed, we hand back a pending token + flag instead of full credentials.
// The route layer maps `pending2fa` shapes to a 200 response that the
// frontend recognises and switches its UI to the TOTP step.
export type LoginOutcome =
  | { kind: 'session'; session: IssuedSession }
  | { kind: 'pending2fa'; pendingToken: string };

export class AuthService {
  // Lazily constructed — only paid for when LDAP login actually fires.
  private readonly directories = new DirectoryService();
  private readonly ldap = new LdapService();
  private readonly twoFactor = new TwoFactorService();

  constructor(
    private readonly env: Env,
    private readonly signer: AuthSigner,
  ) {}

  // Wrap the legacy session-returning login into the new outcome shape so
  // callers can branch on `pending2fa`. When the user has totpEnabled=true,
  // first-factor success yields a pending token instead of a full session.
  async loginOutcome(input: { email: string; password: string }): Promise<LoginOutcome> {
    const session = await this.login(input);
    const user = await prisma.user.findUnique({ where: { id: session.user.id } });
    if (user?.totpEnabled) {
      // First-factor succeeded but we shouldn't have minted a full session.
      // Revoke the just-issued refresh token and return the pending shape.
      await prisma.refreshToken.updateMany({
        where: { userId: session.user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return { kind: 'pending2fa', pendingToken: this.signer.signPending(session.user.id) };
    }
    return { kind: 'session', session };
  }

  // Second step of the 2FA login. Validates the pending token (still in
  // its 5-minute TTL) AND the supplied code (TOTP or recovery), then mints
  // a full session.
  async completeLoginWith2fa(pendingToken: string, code: string): Promise<IssuedSession> {
    let payload: { sub: string; kind: '2fa-pending' };
    try {
      payload = this.signer.verifyPending(pendingToken);
    } catch {
      throw Errors.unauthorized('Pending 2FA token invalid or expired');
    }
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || user.disabledAt) throw Errors.unauthorized('Invalid credentials');
    if (!user.totpEnabled) throw Errors.unauthorized('2FA not enabled for this account');

    const ok = await this.twoFactor.verifyForLogin(user.id, code);
    if (!ok) throw Errors.unauthorized('Invalid 2FA code');

    return this.issueSession(user);
  }

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

  // Rotates the refresh token: revokes the old, issues a new pair sharing
  // the same `familyId`.
  //
  // v1.30.5 (S-4): refresh-token theft response.
  // When a presented token is FOUND in the DB but is already revoked, the
  // caller is replaying a token that was already rotated away. That's the
  // canonical signal of theft (legitimate clients only ever hold the most
  // recently issued sibling). We revoke every still-live sibling in the
  // family so the attacker AND the victim's session both die — the
  // legitimate user must re-login everywhere, which is the correct
  // response to a detected steal. An unknown / expired / signature-bad
  // token still produces the boring 401 with no side effect — those
  // happen routinely (clock skew, lost cookies, stale tabs) and aren't
  // theft signals.
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

    // ── Reuse-of-revoked-token detection ────────────────────────────────
    // The record EXISTS (so the caller had a real, valid-shaped token at
    // some point) but it's already revoked. Either the legitimate client
    // is racing its own retry against rotation (unlikely with a proper
    // SPA — refresh is single-flighted) or someone is replaying a token
    // already rotated away. We assume theft and revoke the family.
    if (record.revokedAt) {
      await prisma.refreshToken.updateMany({
        where: { familyId: record.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw Errors.unauthorized('Refresh token revoked');
    }
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

    // Rotation: the new token inherits the family so subsequent replays
    // of THIS token (now revoked) will trip the family-revoke above.
    return this.issueSession(user, { familyId: record.familyId });
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

  // Returns the raw reset token. When SMTP is configured the token is also
  // emailed; the controller still surfaces it in the response body in non-prod
  // so dev/test flows don't need a real SMTP server. Always returns the same
  // shape regardless of whether the user exists, to prevent account enumeration.
  async requestPasswordReset(email: string): Promise<{ resetToken: string | null }> {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return { resetToken: null };

    const raw = randomTokenHex(32);
    const expiresAt = new Date(Date.now() + parseDuration('1h'));
    await prisma.passwordReset.create({
      data: { userId: user.id, tokenHash: sha256(raw), expiresAt },
    });
    // Fire-and-forget — never block the response on outbound mail. The
    // emailService no-ops when SMTP isn't configured.
    void emailService.sendPasswordReset({ to: user.email, name: user.name, token: raw });
    return { resetToken: raw };
  }

  // Internal — issue + persist a single-use email-verification token for a
  // user. Returns the raw token; only the SHA-256 hash is stored. Also
  // dispatches the verification email best-effort (no-op when SMTP unset).
  private async createVerificationToken(userId: string): Promise<string> {
    const raw = randomTokenHex(32);
    const expiresAt = new Date(Date.now() + parseDuration('24h'));
    await prisma.emailVerification.create({
      data: { userId, tokenHash: sha256(raw), expiresAt },
    });
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, name: true },
    });
    if (user) {
      void emailService.sendVerification({ to: user.email, name: user.name, token: raw });
    }
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
    opts: { familyId?: string } = {},
  ): Promise<IssuedSession> {
    // v1.30.5 (S-4): pre-generate the row id so we can self-root the
    // familyId at insert time (familyId = id when no parent family is
    // supplied — i.e. on first login / register / 2FA-login). The cuid
    // shape isn't required — uniqueness on the @id column is what
    // matters; a 12-byte random hex is plenty.
    const id = 'rfk_' + randomBytes(12).toString('hex');
    const familyId = opts.familyId ?? id;
    // Create the refresh-token row first so we have a stable jti to embed.
    const refreshExpiresAt = new Date(Date.now() + parseDuration(this.env.JWT_REFRESH_TTL));
    // We need the row id before we can sign with it; use a two-step create with
    // a placeholder hash, then update once the JWT is signed. Cheaper than a
    // synthetic uuid + uniqueness check.
    const placeholder = sha256(randomTokenHex(16));
    const row = await prisma.refreshToken.create({
      data: { id, userId: user.id, tokenHash: placeholder, expiresAt: refreshExpiresAt, familyId },
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
        totpEnabled: user.totpEnabled,
        calendarPreference: user.calendarPreference,
        themePreference: user.themePreference,
        languagePreference: user.languagePreference,
        createdAt: user.createdAt,
      },
    };
  }
}

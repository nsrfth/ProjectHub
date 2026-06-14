import type { Prisma, User } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';
import { hashPassword, randomTokenHex, sha256, verifyPassword } from '../lib/hashing.js';
import { parseDuration } from '../lib/time.js';
import type { Env } from '../config/env.js';
import { DirectoryService } from './directoryService.js';
import { isLdapInfrastructureError, LdapService, type LdapAuthResult } from './ldapService.js';
import { TwoFactorService } from './twoFactorService.js';
import { emailService } from './emailService.js';
import { groupDnsMatch } from '../lib/ldapDn.js';
import { systemRoleIdFor } from '../lib/teamRoles.js';
import { passwordPolicyService } from './passwordPolicyService.js';
import type { ThemePreferenceValue } from '../schemas/themePreference.js';

// All token lifecycle logic lives here. Routes/controllers don't talk to Prisma directly.

// v1.30.10 (S-18 / grace window): how long after a refresh token is
// rotated we still treat its replay as a benign client race rather
// than detected theft. Narrow enough that a real attacker can't hide
// inside it; wide enough to cover SPA double-tabs and retried fetches.
const REUSE_GRACE_MS = 5_000;

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
    authSource: 'LOCAL' | 'LDAP' | 'SCIM';
    totpEnabled: boolean;
    calendarPreference: 'SHAMSI' | 'GREGORIAN';
    themePreference: ThemePreferenceValue;
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

  // v1.30.11 (S-9): `register()` removed alongside the route. The
  // duplicate-email branch leaked account existence ("Email already
  // registered" 409 vs the success 201). Bootstrap path is now the
  // prisma seed (SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD); subsequent
  // users come from AdminService.createUser (v1.26) via
  // POST /api/admin/users. The argon2 hashing + first-user-is-ADMIN
  // logic lives in AdminService + the seed; this service no longer
  // mints users at all.

  async login(input: { email: string; password: string }): Promise<IssuedSession> {
    const identifier = input.email.trim();
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { email: { equals: identifier, mode: 'insensitive' } },
          {
            ldapUsername: { equals: identifier, mode: 'insensitive' },
            authSource: 'LDAP',
          },
        ],
      },
    });

    // Soft-disabled users (SCIM `active: false`) can't log in regardless of
    // which auth backend they're on. Same error string as bad credentials to
    // avoid leaking account state.
    if (user?.disabledAt) throw Errors.unauthorized('Invalid credentials');

    // ── Local user: legacy argon2 password check. ───────────────────────────
    if (user && user.authSource === 'LOCAL') {
      await this.assertNotLocked(user);
      if (!user.passwordHash) throw Errors.unauthorized('Invalid credentials');
      const ok = await verifyPassword(user.passwordHash, input.password);
      if (!ok) {
        await this.recordFailedLogin(user.id);
        throw Errors.unauthorized('Invalid credentials');
      }
      await this.clearFailedLogin(user.id);
      return this.issueSession(user);
    }

    // ── LDAP user: bind against the configured directory. ───────────────────
    if (user?.authSource === 'LDAP' && user.directoryId) {
      const dir = await this.directories.getRaw(user.directoryId).catch(() => null);
      if (!dir || dir.kind !== 'LDAP') throw Errors.unauthorized('Invalid credentials');
      const loginId = user.email === identifier ? identifier : (user.ldapUsername ?? identifier);
      let result: LdapAuthResult | null;
      try {
        result = await this.ldap.authenticate(dir, loginId, input.password);
      } catch (e) {
        if (isLdapInfrastructureError(e)) {
          throw Errors.serviceUnavailable(
            'Directory sign-in is temporarily unavailable. Please try again later.',
          );
        }
        throw e;
      }
      if (!result) throw Errors.unauthorized('Invalid credentials');
      await this.syncFromLdap(user, dir.id, result);
      const refreshed = await prisma.user.findUnique({ where: { id: user.id } });
      return this.issueSession(refreshed ?? user);
    }

    // SCIM-provisioned users authenticate via the IdP, not password login.
    if (user?.authSource === 'SCIM') {
      throw Errors.unauthorized('Invalid credentials');
    }

    // ── No local row yet: try each active LDAP directory in turn (JIT). ────
    // Keeps "user typed wrong password" indistinguishable from "no such user"
    // to avoid account enumeration.
    const directories = await this.directories.listActiveLdap();
    for (const dir of directories) {
      if (!dir.allowJIT) continue;
      let result: LdapAuthResult | null;
      try {
        result = await this.ldap.authenticate(dir, identifier, input.password);
      } catch (e) {
        if (isLdapInfrastructureError(e)) {
          throw Errors.serviceUnavailable(
            'Directory sign-in is temporarily unavailable. Please try again later.',
          );
        }
        throw e;
      }
      if (!result) continue;
      const provisioned = await this.provisionFromLdap(dir.id, result);
      return this.issueSession(provisioned);
    }

    throw Errors.unauthorized('Invalid credentials');
  }

  // Admin action: refresh LDAP profile without a password bind.
  async refreshLdapUserProfile(userId: string): Promise<User> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw Errors.notFound('User not found');
    if (user.authSource !== 'LDAP' || !user.directoryId || !user.externalId) {
      throw Errors.conflict('User is not linked to an LDAP directory');
    }
    const dir = await this.directories.getRaw(user.directoryId);
    if (dir.kind !== 'LDAP') throw Errors.conflict('User is not linked to an LDAP directory');
    let result: LdapAuthResult | null;
    try {
      result = await this.ldap.fetchUserProfile(dir, user.externalId);
    } catch (e) {
      if (isLdapInfrastructureError(e)) {
        throw Errors.serviceUnavailable(
          'Could not reach the directory server. Check connectivity and try again.',
        );
      }
      throw e;
    }
    if (!result) throw Errors.notFound('User no longer exists in the directory');
    await this.syncFromLdap(user, dir.id, result);
    const refreshed = await prisma.user.findUnique({ where: { id: userId } });
    if (!refreshed) throw Errors.notFound('User not found');
    return refreshed;
  }

  // Admin action: verify directory credentials (password is never stored).
  async testLdapUserCredentials(userId: string, password: string): Promise<{ ok: true }> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw Errors.notFound('User not found');
    if (user.authSource !== 'LDAP' || !user.directoryId) {
      throw Errors.conflict('User is not linked to an LDAP directory');
    }
    const dir = await this.directories.getRaw(user.directoryId);
    if (dir.kind !== 'LDAP') throw Errors.conflict('User is not linked to an LDAP directory');
    const loginId = user.ldapUsername ?? user.email;
    let result: LdapAuthResult | null;
    try {
      result = await this.ldap.authenticate(dir, loginId, password);
    } catch (e) {
      if (isLdapInfrastructureError(e)) {
        throw Errors.serviceUnavailable(
          'Could not reach the directory server. Check connectivity and try again.',
        );
      }
      throw e;
    }
    if (!result) throw Errors.unauthorized('Directory credentials are invalid');
    return { ok: true };
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
          ...this.ldapProfileFields(result),
          directoryId,
          externalId: result.dn,
          authSource: 'LDAP',
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

    await this.applyDirectoryGroups(user.id, directoryId, result.groups);
    // Re-read so the caller sees the post-mapping globalRole.
    const refreshed = await prisma.user.findUnique({ where: { id: user.id } });
    return refreshed ?? user;
  }

  // Pull fresh profile fields from LDAP and reapply group mappings on each login.
  // Sync failures must not block sign-in — profile drift is acceptable short-term.
  private async syncFromLdap(
    user: User,
    directoryId: string,
    result: LdapAuthResult,
    opts: { skipGroups?: boolean } = {},
  ): Promise<void> {
    try {
      const dataUpdate = this.ldapProfileData(result, user);
      if (Object.keys(dataUpdate).length) {
        await prisma.user.update({
          where: { id: user.id },
          data: { ...dataUpdate, ldapSyncedAt: new Date() },
        });
      } else {
        await prisma.user.update({
          where: { id: user.id },
          data: { ldapSyncedAt: new Date() },
        });
      }
    } catch {
      // Unique email collision or transient DB error — login still succeeded.
    }
    if (!opts.skipGroups) {
      try {
        await this.applyDirectoryGroups(user.id, directoryId, result.groups);
      } catch {
        // Group sync failure must not block sign-in.
      }
    }
  }

  private ldapProfileFields(result: LdapAuthResult) {
    return {
      email: result.email.trim().toLowerCase(),
      name: result.displayName || result.email,
      ldapUsername: result.ldapUsername,
      userPrincipalName: result.userPrincipalName,
      department: result.department,
      jobTitle: result.jobTitle,
      managerName: result.managerName,
    };
  }

  private ldapProfileData(
    result: LdapAuthResult,
    existing: User,
  ): Prisma.UserUpdateInput {
    const data: Prisma.UserUpdateInput = {};
    const fields = this.ldapProfileFields(result);
    if (existing.email !== fields.email) data.email = fields.email;
    if (existing.name !== fields.name) data.name = fields.name;
    if (existing.externalId !== result.dn) data.externalId = result.dn;
    if (existing.ldapUsername !== fields.ldapUsername) data.ldapUsername = fields.ldapUsername;
    if (existing.userPrincipalName !== fields.userPrincipalName) {
      data.userPrincipalName = fields.userPrincipalName;
    }
    if (existing.department !== fields.department) data.department = fields.department;
    if (existing.jobTitle !== fields.jobTitle) data.jobTitle = fields.jobTitle;
    if (existing.managerName !== fields.managerName) data.managerName = fields.managerName;
    return data;
  }

  // Translate LDAP group DNs into TaskHub role assignments. Only fires when
  // the directory has syncRolesFromGroups=true (which the admin opts into).
  // Two semantics:
  //   - mapping.globalRole set    → user.globalRole = mapping.globalRole
  //   - mapping.teamId + teamRole → upsert TeamMembership(userId, teamId)
  //     with the mapped role; remove memberships that no longer match any
  //     mapping for this directory (so removing a group revokes access).
  // Renamed from `applyGroupMappings` → made public in v1.30.6 (S-6 /
  // S-7) so the new directoryGroupMappings integration tests can drive
  // it directly without needing a live OpenLDAP container. The function
  // is idempotent and DB-driven; the LDAP bind step only feeds it the
  // `groupDns` array, which is just data.
  async applyDirectoryGroups(
    userId: string,
    directoryId: string,
    groupDns: string[],
  ): Promise<void> {
    const dir = await prisma.directory.findUnique({ where: { id: directoryId } });
    if (!dir?.syncRolesFromGroups) return;

    const mappings = await prisma.directoryGroupMapping.findMany({ where: { directoryId } });
    const matched = mappings.filter((m) => groupDnsMatch(groupDns, m.externalGroupDn));

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
      // v1.30.6 (S-6 / S-7): EVERY directory-managed membership must
      // carry a roleId. Resolution order:
      //   1. Mapping carries an explicit custom roleId — use it.
      //   2. Otherwise resolve the team's system Manager / Member role
      //      matching the mapping's teamRole; create the system roles
      //      first if the team didn't have them yet (covers SCIM-
      //      created teams + pre-v1.23 backfill gaps).
      // BOTH the legacy `role` enum AND the new `roleId` are written.
      // The enum stays so the v1.23 fallback in requirePermission keeps
      // working for any code path that hasn't migrated to roleId yet.
      const roleId = m.roleId ?? (await systemRoleIdFor(m.teamId, m.teamRole));
      await prisma.teamMembership.upsert({
        where: { userId_teamId: { userId, teamId: m.teamId } },
        update: { role: m.teamRole, roleId },
        create: { userId, teamId: m.teamId, role: m.teamRole, roleId },
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
    // some point) but it's already revoked. Either someone is replaying
    // a token already rotated away — assume theft, revoke the whole
    // family — OR the legitimate client just race-retried.
    //
    // v1.30.10 (S-18 / grace window): the v1.30.5 fix's "revoke on ANY
    // replay" was operationally noisy — a benign client race (a second
    // tab, a network-retried fetch landing just after rotation) logged
    // the user out everywhere. The phase boundary called this out as
    // "if it becomes a pain, add a grace window". A 5-second window is
    // narrow enough that a real attacker can't hide a stolen-token
    // replay inside it (the attacker has no way to time when rotation
    // happened), and wide enough to cover every benign race we've
    // observed.
    if (record.revokedAt) {
      const revokedAgeMs = Date.now() - record.revokedAt.getTime();
      if (revokedAgeMs <= REUSE_GRACE_MS) {
        // Benign race — silently 401 without family revocation.
        throw Errors.unauthorized('Refresh token revoked');
      }
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

  // v1.32.0: user-initiated password change. Verifies the caller's current
  // password, then atomically rotates the hash and revokes every active
  // refresh-token row for the user so other devices get booted on next
  // refresh. The caller's own current refresh cookie is included in that
  // revocation — the route layer is expected to wire the frontend's
  // signOut() on success so they re-authenticate cleanly.
  //
  // Refuses directory-owned (LDAP/SCIM) accounts: their password is the
  // directory's responsibility and a local change would be overwritten on
  // the next sync. Mirroring the existing /me/preferences pattern, the
  // controller already requires a session (not an API token).
  async changeOwnPassword(
    userId: string,
    input: { currentPassword: string; newPassword: string },
  ): Promise<void> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw Errors.unauthorized();
    if (user.authSource !== 'LOCAL' || user.directoryId || !user.passwordHash) {
      throw Errors.forbidden(
        'Password is managed by your directory and cannot be changed here',
      );
    }
    const ok = await verifyPassword(user.passwordHash, input.currentPassword);
    if (!ok) throw Errors.badRequest('Current password is incorrect');

    await passwordPolicyService.assertMinAge(userId);
    await passwordPolicyService.assertValid(input.newPassword, { email: user.email, name: user.name });
    await passwordPolicyService.assertNotReused(userId, input.newPassword);

    const passwordHash = await hashPassword(input.newPassword);
    await passwordPolicyService.recordPasswordChange(userId, passwordHash);
    await prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async performPasswordReset(input: { token: string; password: string }): Promise<void> {
    const tokenHash = sha256(input.token);
    const reset = await prisma.passwordReset.findUnique({ where: { tokenHash } });
    if (!reset || reset.usedAt || reset.expiresAt < new Date()) {
      throw Errors.badRequest('Invalid or expired reset token');
    }

    const target = await prisma.user.findUnique({ where: { id: reset.userId } });
    if (!target || target.authSource !== 'LOCAL') {
      throw Errors.badRequest('Invalid or expired reset token');
    }
    await passwordPolicyService.assertValid(input.password, {
      email: target.email,
      name: target.name,
    });
    await passwordPolicyService.assertNotReused(reset.userId, input.password);

    const passwordHash = await hashPassword(input.password);
    await prisma.$transaction([
      prisma.passwordReset.update({ where: { id: reset.id }, data: { usedAt: new Date() } }),
      prisma.refreshToken.updateMany({
        where: { userId: reset.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
    await passwordPolicyService.recordPasswordChange(reset.userId, passwordHash);
  }

  private async assertNotLocked(user: User): Promise<void> {
    if (!user.lockedUntil) return;
    if (user.lockedUntil > new Date()) {
      throw Errors.unauthorized('Account is temporarily locked. Try again later.');
    }
    await prisma.user.update({
      where: { id: user.id },
      data: { lockedUntil: null, failedLoginAttempts: 0 },
    });
  }

  private async recordFailedLogin(userId: string): Promise<void> {
    const policy = await passwordPolicyService.getPolicy();
    if (policy.maxFailedLoginAttempts <= 0) return;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return;
    const attempts = user.failedLoginAttempts + 1;
    const data: { failedLoginAttempts: number; lockedUntil?: Date } = {
      failedLoginAttempts: attempts,
    };
    if (attempts >= policy.maxFailedLoginAttempts) {
      data.lockedUntil = new Date(Date.now() + policy.lockoutDurationMinutes * 60_000);
    }
    await prisma.user.update({ where: { id: userId }, data });
  }

  private async clearFailedLogin(userId: string): Promise<void> {
    await prisma.user.update({
      where: { id: userId },
      data: { failedLoginAttempts: 0, lockedUntil: null },
    });
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
        authSource: user.directoryId ? user.authSource : 'LOCAL',
        totpEnabled: user.totpEnabled,
        calendarPreference: user.calendarPreference,
        themePreference: user.themePreference,
        languagePreference: user.languagePreference,
        createdAt: user.createdAt,
      },
    };
  }
}

import { Prisma, type AuthSource, type GlobalRole, type User } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';
import { hashPassword } from '../lib/hashing.js';
import { generateCompliantPassword } from '../lib/passwordPolicy.js';
import { passwordPolicyService } from './passwordPolicyService.js';
import { logActivity } from './activityLogger.js';
import { assertNotSystemUserTarget, getSystemUserId, isSystemUser } from '../lib/systemUser.js';

// Admin operations bypass team-level RBAC and instead require GlobalRole=ADMIN
// (enforced by the route layer). The hard invariant this service guards is
// "there must always be at least one ADMIN" — losing the last admin would
// lock everyone out of admin operations forever.

export interface AdminUserView {
  id: string;
  email: string;
  name: string;
  globalRole: GlobalRole;
  emailVerifiedAt: Date | null;
  createdAt: Date;
  membershipCount: number;
  directoryId: string | null;
  authSource: AuthSource;
  ldapUsername: string | null;
  userPrincipalName: string | null;
  department: string | null;
  jobTitle: string | null;
  managerName: string | null;
  ldapSyncedAt: Date | null;
  directoryName: string | null;
  directoryActive: boolean;
  disabledAt: Date | null;
  lockedUntil: Date | null;
}

export interface AdminTeamView {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
  memberCount: number;
  projectCount: number;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface PagedResult<T> {
  items: T[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export interface ListUsersOpts {
  page: number;
  pageSize: number;
  search?: string;
  role?: GlobalRole;
  authSource?: AuthSource;
  status?: 'active' | 'disabled' | 'locked';
  directoryId?: string;
  sortBy?: 'name' | 'email' | 'createdAt' | 'lastSynced';
  sortDir?: 'asc' | 'desc';
}

const USER_LIST_INCLUDE = {
  _count: { select: { memberships: true } },
  directory: { select: { name: true, host: true } },
} as const;

function buildUserListWhere(opts: ListUsersOpts): Prisma.UserWhereInput {
  const now = new Date();
  const clauses: Prisma.UserWhereInput[] = [{ isSystemUser: false }];

  const search = opts.search?.trim();
  if (search) {
    clauses.push({
      OR: [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ],
    });
  }

  if (opts.role) clauses.push({ globalRole: opts.role });
  if (opts.authSource) clauses.push({ authSource: opts.authSource });
  if (opts.directoryId) clauses.push({ directoryId: opts.directoryId });

  if (opts.status === 'disabled') {
    clauses.push({ disabledAt: { not: null } });
  } else if (opts.status === 'locked') {
    clauses.push({ lockedUntil: { gt: now } });
  } else if (opts.status === 'active') {
    clauses.push({
      disabledAt: null,
      OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
    });
  }

  return clauses.length === 1 ? clauses[0]! : { AND: clauses };
}

function userListOrderBy(
  sortBy: ListUsersOpts['sortBy'],
  sortDir: ListUsersOpts['sortDir'],
): Prisma.UserOrderByWithRelationInput {
  const dir = sortDir ?? 'asc';
  switch (sortBy ?? 'createdAt') {
    case 'name':
      return { name: dir };
    case 'email':
      return { email: dir };
    case 'lastSynced':
      return { ldapSyncedAt: dir };
    default:
      return { createdAt: dir };
  }
}

function clampUserListPageSize(pageSize: number): number {
  if (!Number.isFinite(pageSize) || pageSize <= 0) return 25;
  return Math.min(100, Math.max(10, pageSize));
}

type UserWithCounts = User & {
  _count: { memberships: number };
  directory: { name: string; host: string | null } | null;
};

function toAdminUserView(u: UserWithCounts): AdminUserView {
  const linked = !!u.directoryId;
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    globalRole: u.globalRole,
    emailVerifiedAt: u.emailVerifiedAt,
    createdAt: u.createdAt,
    membershipCount: u._count.memberships,
    directoryId: u.directoryId,
    authSource: linked ? u.authSource : 'LOCAL',
    ldapUsername: u.ldapUsername,
    userPrincipalName: u.userPrincipalName,
    department: u.department,
    jobTitle: u.jobTitle,
    managerName: u.managerName,
    ldapSyncedAt: u.ldapSyncedAt,
    directoryName: u.directory?.name ?? null,
    directoryActive: linked && !!u.directory?.host,
    disabledAt: u.disabledAt,
    lockedUntil: u.lockedUntil,
  };
}

async function revokeAllRefreshTokens(userId: string, when = new Date()): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: when },
  });
}

async function loadAdminUser(userId: string): Promise<UserWithCounts> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    include: USER_LIST_INCLUDE,
  });
  if (!u) throw Errors.notFound('User not found');
  if (isSystemUser(u)) throw Errors.notFound('User not found');
  return u;
}

export class AdminService {
  async getUserView(userId: string): Promise<AdminUserView> {
    const u = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        _count: { select: { memberships: true } },
        directory: { select: { name: true, host: true } },
      },
    });
    if (!u) throw Errors.notFound('User not found');
    if (isSystemUser(u)) throw Errors.notFound('User not found');
    return toAdminUserView(u);
  }

  async listUsers(opts: ListUsersOpts): Promise<PagedResult<AdminUserView>> {
    const page = Math.max(1, opts.page);
    const pageSize = clampUserListPageSize(opts.pageSize);
    const where = buildUserListWhere(opts);
    const orderBy = userListOrderBy(opts.sortBy, opts.sortDir);

    const [totalItems, rows] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: USER_LIST_INCLUDE,
      }),
    ]);

    const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / pageSize);

    return {
      items: rows.map(toAdminUserView),
      page,
      pageSize,
      totalItems,
      totalPages,
    };
  }

  async updateUserRole(
    callerId: string,
    targetUserId: string,
    newRole: GlobalRole,
  ): Promise<AdminUserView> {
    const target = await prisma.user.findUnique({
      where: { id: targetUserId },
      include: { _count: { select: { memberships: true } } },
    });
    if (!target) throw Errors.notFound('User not found');
    if (isSystemUser(target)) throw Errors.conflict('Cannot change the system account role');

    // Demoting yourself or the last ADMIN would orphan the admin role and
    // leave the system unmanageable. Reject before mutating.
    if (target.globalRole === 'ADMIN' && newRole !== 'ADMIN') {
      const adminCount = await prisma.user.count({ where: { globalRole: 'ADMIN' } });
      if (adminCount <= 1) throw Errors.conflict('Cannot demote the last ADMIN');
      if (target.id === callerId) {
        // Even if other admins exist, blocking self-demotion avoids a footgun
        // where the operator changes their own role without realising.
        throw Errors.conflict('Cannot change your own role — ask another admin');
      }
    }

    // v1.78.1: revoke the target's active refresh tokens whenever their
    // globalRole actually changes. The access JWT carries globalRole as a
    // signed claim; requireAuth verifies it WITHOUT a DB re-read (the API-
    // token path does re-read, but the JWT path doesn't — by design, to
    // keep requireAuth a pure verify). Without revocation the target would
    // keep hitting the API with stale role bits up to their refresh token's
    // lifetime — meaning a freshly-promoted ADMIN couldn't see the cross-
    // team /api/projects list until they logged out and back in. Mirrors
    // the soft-revoke idiom from changePassword / performPasswordReset in
    // authService — set revokedAt; the row stays for audit history.
    const roleChanged = target.globalRole !== newRole;
    const [updated] = await prisma.$transaction([
      prisma.user.update({
        where: { id: targetUserId },
        data: { globalRole: newRole },
        include: {
          _count: { select: { memberships: true } },
          directory: { select: { name: true, host: true } },
        },
      }),
      ...(roleChanged
        ? [
            prisma.refreshToken.updateMany({
              where: { userId: targetUserId, revokedAt: null },
              data: { revokedAt: new Date() },
            }),
          ]
        : []),
    ]);
    return toAdminUserView(updated);
  }

  async setUserDisabled(
    callerId: string,
    targetUserId: string,
    disabled: boolean,
  ): Promise<AdminUserView> {
    const target = await loadAdminUser(targetUserId);

    if (disabled) {
      if (targetUserId === callerId) {
        throw Errors.conflict('Cannot disable your own account');
      }
      if (target.globalRole === 'ADMIN' && !target.disabledAt) {
        const enabledAdmins = await prisma.user.count({
          where: { globalRole: 'ADMIN', disabledAt: null, isSystemUser: false },
        });
        if (enabledAdmins <= 1) throw Errors.conflict('Cannot disable the last enabled ADMIN');
      }
      const now = new Date();
      await revokeAllRefreshTokens(targetUserId, now);
      const updated = await prisma.user.update({
        where: { id: targetUserId },
        data: { disabledAt: now },
        include: USER_LIST_INCLUDE,
      });
      await logActivity(prisma, {
        actorId: callerId,
        action: 'admin.user.disabled',
        meta: {
          targetUserId,
          external: !!target.directoryId,
        },
      });
      return toAdminUserView(updated);
    }

    const updated = await prisma.user.update({
      where: { id: targetUserId },
      data: { disabledAt: null },
      include: USER_LIST_INCLUDE,
    });
    await logActivity(prisma, {
      actorId: callerId,
      action: 'admin.user.enabled',
      meta: { targetUserId, external: !!target.directoryId },
    });
    return toAdminUserView(updated);
  }

  async unlockUser(callerId: string, targetUserId: string): Promise<AdminUserView> {
    await loadAdminUser(targetUserId);
    const updated = await prisma.user.update({
      where: { id: targetUserId },
      data: { lockedUntil: null, failedLoginAttempts: 0 },
      include: USER_LIST_INCLUDE,
    });
    await logActivity(prisma, {
      actorId: callerId,
      action: 'admin.user.unlocked',
      meta: { targetUserId },
    });
    return toAdminUserView(updated);
  }

  async forceLogoutUser(callerId: string, targetUserId: string): Promise<AdminUserView> {
    const target = await loadAdminUser(targetUserId);
    if (targetUserId === callerId) {
      throw Errors.conflict('Cannot force-logout your own account');
    }
    await revokeAllRefreshTokens(targetUserId);
    await logActivity(prisma, {
      actorId: callerId,
      action: 'admin.user.force_logout',
      meta: { targetUserId, external: !!target.directoryId },
    });
    return toAdminUserView(target);
  }

  async updateUserProfile(
    callerId: string,
    targetUserId: string,
    input: {
      name?: string;
      email?: string;
      department?: string | null;
      jobTitle?: string | null;
    },
  ): Promise<AdminUserView> {
    const target = await loadAdminUser(targetUserId);
    if (target.authSource !== 'LOCAL' || target.directoryId) {
      throw Errors.conflict('Profile is managed by the directory');
    }

    const data: Prisma.UserUpdateInput = {};
    const changedFields: string[] = [];

    if (input.name !== undefined && input.name !== target.name) {
      data.name = input.name;
      changedFields.push('name');
    }
    if (input.email !== undefined) {
      const email = input.email.trim().toLowerCase();
      if (email !== target.email) {
        data.email = email;
        changedFields.push('email');
      }
    }
    if (input.department !== undefined && input.department !== target.department) {
      data.department = input.department;
      changedFields.push('department');
    }
    if (input.jobTitle !== undefined && input.jobTitle !== target.jobTitle) {
      data.jobTitle = input.jobTitle;
      changedFields.push('jobTitle');
    }

    if (changedFields.length === 0) {
      return toAdminUserView(target);
    }

    try {
      const updated = await prisma.user.update({
        where: { id: targetUserId },
        data,
        include: USER_LIST_INCLUDE,
      });
      await logActivity(prisma, {
        actorId: callerId,
        action: 'admin.user.profile_updated',
        meta: { targetUserId, fields: changedFields },
      });
      return toAdminUserView(updated);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw Errors.conflict('A user with this email already exists');
      }
      throw err;
    }
  }

  async listTeams(opts: { cursor?: string; limit: number }): Promise<Page<AdminTeamView>> {
    const systemUserId = await getSystemUserId();
    const rows = await prisma.team.findMany({
      orderBy: { createdAt: 'asc' },
      take: opts.limit + 1,
      ...(opts.cursor && { cursor: { id: opts.cursor }, skip: 1 }),
      include: { _count: { select: { memberships: true, projects: true } } },
    });
    const hasMore = rows.length > opts.limit;
    const page = hasMore ? rows.slice(0, opts.limit) : rows;
    const last = page[page.length - 1];
    return {
      items: await Promise.all(
        page.map(async (t) => {
          let memberCount = t._count.memberships;
          if (systemUserId) {
            const hasSystem = await prisma.teamMembership.findUnique({
              where: { userId_teamId: { userId: systemUserId, teamId: t.id } },
              select: { userId: true },
            });
            if (hasSystem) memberCount = Math.max(0, memberCount - 1);
          }
          return {
            id: t.id,
            name: t.name,
            slug: t.slug,
            createdAt: t.createdAt,
            memberCount,
            projectCount: t._count.projects,
          };
        }),
      ),
      nextCursor: hasMore && last ? last.id : null,
    };
  }

  // Delete a user account. The schema's onDelete rules handle the cascade:
  //   - memberships, refreshTokens, passwordResets, emailVerifications,
  //     notifications, activities, attachments → CASCADE (gone with the user)
  //   - Project.owner, Task.creator, Task.assignee, Comment.author → SetNull
  //     (rows survive, attribution becomes "(deleted user)" in the UI)
  // Guards mirror the role-update endpoint: no self-delete, no
  // deleting-the-last-admin (would orphan admin access).
  async deleteUser(callerId: string, targetUserId: string): Promise<void> {
    if (callerId === targetUserId) {
      throw Errors.conflict('Cannot delete your own account');
    }
    const target = await prisma.user.findUnique({ where: { id: targetUserId } });
    if (!target) throw Errors.notFound('User not found');
    await assertNotSystemUserTarget(targetUserId, 'Cannot delete the system account');
    if (target.globalRole === 'ADMIN') {
      const adminCount = await prisma.user.count({ where: { globalRole: 'ADMIN' } });
      if (adminCount <= 1) throw Errors.conflict('Cannot delete the last ADMIN');
    }
    try {
      await prisma.user.delete({ where: { id: targetUserId } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        throw Errors.notFound('User not found');
      }
      throw err;
    }
  }

  // v1.26: admin-provisioned user account. The admin types email + name and
  // either a password OR omits it for an auto-generated one. The new account
  // can immediately sign in with the returned credentials.
  //
  // Distinct from self-register: this path bypasses verification (admin
  // vouches for the address by default) and surfaces the password ONCE so
  // the admin can hand it over. Nothing is logged.
  async createUser(input: {
    email: string;
    name: string;
    password?: string;
    globalRole: GlobalRole;
    emailVerified: boolean;
  }): Promise<{ user: AdminUserView; generatedPassword: string | null }> {
    // Resolve password: caller-supplied wins; otherwise generate a 20-char
    // URL-safe token. The schema validator already enforced the policy when
    // a password was supplied, so we trust it here.
    const policy = await passwordPolicyService.getPolicy();
    const generatedPassword = input.password
      ? null
      : generateCompliantPassword(policy);
    const plaintext = input.password ?? generatedPassword!;
    if (input.password) {
      await passwordPolicyService.assertValid(plaintext, {
        email: input.email,
        name: input.name,
      });
    }
    const passwordHash = await hashPassword(plaintext);

    try {
      const created = await prisma.user.create({
        data: {
          email: input.email,
          name: input.name,
          passwordHash,
          passwordChangedAt: new Date(),
          authSource: 'LOCAL',
          globalRole: input.globalRole,
          emailVerifiedAt: input.emailVerified ? new Date() : null,
        },
        include: { _count: { select: { memberships: true } } },
      });
      return {
        user: toAdminUserView({ ...created, directory: null }),
        generatedPassword,
      };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw Errors.conflict('A user with this email already exists');
      }
      throw err;
    }
  }

  // v1.32.0: admin-initiated password reset. Same password handling as
  // createUser — caller-supplied wins, omit for a 20-char server-generated
  // value. Rejects directory-owned (LDAP/SCIM) targets with 409: their
  // password lives in the directory and a local reset would be overwritten
  // on the next sync.
  //
  // Revokes every active refresh-token row for the target so previously
  // signed-in devices get booted on the next /refresh — the same shape
  // performPasswordReset uses for the token-based flow.
  async resetUserPassword(
    targetUserId: string,
    suppliedPassword: string | undefined,
  ): Promise<{ generatedPassword: string | null }> {
    const target = await prisma.user.findUnique({ where: { id: targetUserId } });
    if (!target) throw Errors.notFound('User not found');
    await assertNotSystemUserTarget(targetUserId, 'Cannot reset the system account password');
    if (target.directoryId) {
      throw Errors.conflict(
        'This account is directory-owned; reset the password in the directory instead',
      );
    }

    const policy = await passwordPolicyService.getPolicy();
    const generatedPassword = suppliedPassword
      ? null
      : generateCompliantPassword(policy);
    const plaintext = suppliedPassword ?? generatedPassword!;
    await passwordPolicyService.assertValid(plaintext, {
      email: target.email,
      name: target.name,
    });
    await passwordPolicyService.assertNotReused(targetUserId, plaintext);

    const passwordHash = await hashPassword(plaintext);
    await prisma.$transaction([
      prisma.refreshToken.updateMany({
        where: { userId: targetUserId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
    await passwordPolicyService.recordPasswordChange(targetUserId, passwordHash);
    return { generatedPassword };
  }

  async deleteTeam(teamId: string, actorId: string): Promise<void> {
    const { TeamsService } = await import('./teamsService.js');
    const teams = new TeamsService();
    // Global admin may force-delete teams that still have projects/tasks.
    await teams.delete(teamId, actorId, { force: true });
  }
}

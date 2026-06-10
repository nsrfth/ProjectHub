import { Prisma, type AuthSource, type GlobalRole, type User } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';
import { hashPassword } from '../lib/hashing.js';
import { generateCompliantPassword } from '../lib/passwordPolicy.js';
import { passwordPolicyService } from './passwordPolicyService.js';
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
  };
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

  async listUsers(opts: { cursor?: string; limit: number }): Promise<Page<AdminUserView>> {
    // Cursor pagination: fetch limit+1 to know if there's a next page without
    // a separate count query. The last item is the cursor for the next page.
    const rows = await prisma.user.findMany({
      where: { isSystemUser: false },
      orderBy: { createdAt: 'asc' },
      take: opts.limit + 1,
      ...(opts.cursor && { cursor: { id: opts.cursor }, skip: 1 }),
      include: {
        _count: { select: { memberships: true } },
        directory: { select: { name: true, host: true } },
      },
    });
    const hasMore = rows.length > opts.limit;
    const page = hasMore ? rows.slice(0, opts.limit) : rows;
    const last = page[page.length - 1];
    return {
      items: page.map(toAdminUserView),
      nextCursor: hasMore && last ? last.id : null,
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

    const updated = await prisma.user.update({
      where: { id: targetUserId },
      data: { globalRole: newRole },
      include: {
        _count: { select: { memberships: true } },
        directory: { select: { name: true, host: true } },
      },
    });
    return toAdminUserView(updated);
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

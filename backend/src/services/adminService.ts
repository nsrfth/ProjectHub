import { Prisma, type GlobalRole } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';
import { hashPassword } from '../lib/hashing.js';
import { randomBytes } from 'node:crypto';

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

export class AdminService {
  async listUsers(opts: { cursor?: string; limit: number }): Promise<Page<AdminUserView>> {
    // Cursor pagination: fetch limit+1 to know if there's a next page without
    // a separate count query. The last item is the cursor for the next page.
    const rows = await prisma.user.findMany({
      orderBy: { createdAt: 'asc' },
      take: opts.limit + 1,
      ...(opts.cursor && { cursor: { id: opts.cursor }, skip: 1 }),
      include: { _count: { select: { memberships: true } } },
    });
    const hasMore = rows.length > opts.limit;
    const page = hasMore ? rows.slice(0, opts.limit) : rows;
    const last = page[page.length - 1];
    return {
      items: page.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        globalRole: u.globalRole,
        emailVerifiedAt: u.emailVerifiedAt,
        createdAt: u.createdAt,
        membershipCount: u._count.memberships,
      })),
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
      include: { _count: { select: { memberships: true } } },
    });
    return {
      id: updated.id,
      email: updated.email,
      name: updated.name,
      globalRole: updated.globalRole,
      emailVerifiedAt: updated.emailVerifiedAt,
      createdAt: updated.createdAt,
      membershipCount: updated._count.memberships,
    };
  }

  async listTeams(opts: { cursor?: string; limit: number }): Promise<Page<AdminTeamView>> {
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
      items: page.map((t) => ({
        id: t.id,
        name: t.name,
        slug: t.slug,
        createdAt: t.createdAt,
        memberCount: t._count.memberships,
        projectCount: t._count.projects,
      })),
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
    const generatedPassword = input.password
      ? null
      : // 15 bytes -> 20 base64 chars; strip URL-unfriendly chars to keep it
        // copy-paste-safe (no + / =) and add a trailing digit so it always
        // satisfies the "must contain digits" rule.
        (randomBytes(15).toString('base64').replace(/[+/=]/g, '').slice(0, 19) + '7');
    const plaintext = input.password ?? generatedPassword!;
    const passwordHash = await hashPassword(plaintext);

    try {
      const created = await prisma.user.create({
        data: {
          email: input.email,
          name: input.name,
          passwordHash,
          globalRole: input.globalRole,
          emailVerifiedAt: input.emailVerified ? new Date() : null,
        },
        include: { _count: { select: { memberships: true } } },
      });
      return {
        user: {
          id: created.id,
          email: created.email,
          name: created.name,
          globalRole: created.globalRole,
          emailVerifiedAt: created.emailVerifiedAt,
          createdAt: created.createdAt,
          membershipCount: created._count.memberships,
        },
        generatedPassword,
      };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw Errors.conflict('A user with this email already exists');
      }
      throw err;
    }
  }

  async deleteTeam(teamId: string): Promise<void> {
    // Team is the parent of memberships, projects, labels, notifications.
    // Each cascades from Team in the schema, so this single delete tears
    // down the entire tenant cleanly.
    try {
      await prisma.team.delete({ where: { id: teamId } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        throw Errors.notFound('Team not found');
      }
      throw err;
    }
  }
}

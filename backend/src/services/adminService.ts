import { Prisma, type GlobalRole } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';

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

export class AdminService {
  async listUsers(): Promise<AdminUserView[]> {
    // Single trip — leverage Prisma's _count to avoid an N+1.
    const rows = await prisma.user.findMany({
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { memberships: true } } },
    });
    return rows.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      globalRole: u.globalRole,
      emailVerifiedAt: u.emailVerifiedAt,
      createdAt: u.createdAt,
      membershipCount: u._count.memberships,
    }));
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

  async listTeams(): Promise<AdminTeamView[]> {
    const rows = await prisma.team.findMany({
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { memberships: true, projects: true } } },
    });
    return rows.map((t) => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
      createdAt: t.createdAt,
      memberCount: t._count.memberships,
      projectCount: t._count.projects,
    }));
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

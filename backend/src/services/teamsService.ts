import { Prisma, type GlobalRole, type TeamRole } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';
import type { Permission } from '../lib/permissions.js';
import { listMembershipPermissions } from '../middleware/requirePermission.js';
import { logActivity } from './activityLogger.js';

// Business rules for teams + membership. Route layer enforces auth/RBAC and
// passes the caller's userId; this layer enforces invariants like
// "every team always has at least one MANAGER" so the team can never be orphaned.

export interface TeamWithRole {
  id: string;
  name: string;
  slug: string;
  color: string | null;
  createdAt: Date;
  myRole: TeamRole;
}

export interface TeamMemberView {
  userId: string;
  email: string;
  name: string;
  role: TeamRole;
  // v1.23: custom role pointer + joined name. Null when the membership row
  // still relies on the legacy `role` enum fallback (rare; only during
  // migration).
  roleId: string | null;
  roleName: string | null;
  joinedAt: Date;
}

export interface TeamCapabilities {
  editDetails: boolean;
  deleteTeam: boolean;
}

export interface TeamDeleteBlockers {
  canDelete: boolean;
  projectCount: number;
  taskCount: number;
  memberCount: number;
  reasons: string[];
}

function permGranted(perms: Set<string>, permission: Permission): boolean {
  return perms.has('*') || perms.has(permission);
}

export class TeamsService {
  async create(
    creatorId: string,
    input: { name: string; slug: string; color?: string },
  ): Promise<TeamWithRole> {
    try {
      const team = await prisma.team.create({
        data: {
          name: input.name,
          slug: input.slug,
          color: input.color ?? null,
          memberships: { create: { userId: creatorId, role: 'MANAGER' } },
        },
      });
      return {
        id: team.id,
        name: team.name,
        slug: team.slug,
        color: team.color,
        createdAt: team.createdAt,
        myRole: 'MANAGER',
      };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw Errors.conflict('Slug already taken');
      }
      throw err;
    }
  }

  async listMine(userId: string): Promise<TeamWithRole[]> {
    const memberships = await prisma.teamMembership.findMany({
      where: { userId },
      include: { team: true },
      orderBy: { team: { createdAt: 'asc' } },
    });
    return memberships.map((m) => ({
      id: m.team.id,
      name: m.team.name,
      slug: m.team.slug,
      color: m.team.color,
      createdAt: m.team.createdAt,
      myRole: m.role,
    }));
  }

  async getDetail(
    userId: string,
    teamId: string,
    globalRole: GlobalRole = 'MEMBER',
  ): Promise<{
    team: TeamWithRole;
    members: TeamMemberView[];
    capabilities: TeamCapabilities;
    deleteBlockers: TeamDeleteBlockers | null;
  }> {
    const team = await prisma.team.findUnique({
      where: { id: teamId },
      include: {
        memberships: {
          include: { user: true, customRole: { select: { name: true } } },
          orderBy: { joinedAt: 'asc' },
        },
      },
    });
    if (!team) throw Errors.notFound('Team not found');

    const myMembership = team.memberships.find((m) => m.userId === userId);
    if (!myMembership) throw Errors.forbidden('Not a team member');

    const perms = await listMembershipPermissions(myMembership, globalRole);
    const capabilities: TeamCapabilities = {
      editDetails: permGranted(perms, 'team.edit_details'),
      deleteTeam: permGranted(perms, 'team.delete'),
    };
    const deleteBlockers = capabilities.deleteTeam
      ? await this.getDeleteBlockers(teamId)
      : null;

    return {
      team: {
        id: team.id,
        name: team.name,
        slug: team.slug,
        color: team.color,
        createdAt: team.createdAt,
        myRole: myMembership.role,
      },
      members: team.memberships.map((m) => ({
        userId: m.userId,
        email: m.user.email,
        name: m.user.name,
        role: m.role,
        roleId: m.roleId,
        roleName: m.customRole?.name ?? null,
        joinedAt: m.joinedAt,
      })),
      capabilities,
      deleteBlockers,
    };
  }

  async getDeleteBlockers(teamId: string): Promise<TeamDeleteBlockers> {
    const [projectCount, taskCount, memberCount] = await Promise.all([
      prisma.project.count({ where: { teamId } }),
      prisma.task.count({ where: { teamId, deletedAt: null } }),
      prisma.teamMembership.count({ where: { teamId } }),
    ]);
    const reasons: string[] = [];
    if (projectCount > 0) {
      reasons.push(
        `${projectCount} active project${projectCount === 1 ? '' : 's'} belong to this team`,
      );
    }
    if (taskCount > 0) {
      reasons.push(
        `${taskCount} active task${taskCount === 1 ? '' : 's'} belong to this team`,
      );
    }
    return {
      canDelete: reasons.length === 0,
      projectCount,
      taskCount,
      memberCount,
      reasons,
    };
  }

  async update(
    teamId: string,
    actorId: string,
    input: { name?: string; slug?: string; color?: string | null },
  ): Promise<TeamWithRole & { myRole: TeamRole }> {
    if (input.name === undefined && input.slug === undefined && input.color === undefined) {
      throw Errors.badRequest('Provide at least one field to update');
    }
    const existing = await prisma.team.findUnique({ where: { id: teamId } });
    if (!existing) throw Errors.notFound('Team not found');

    try {
      const team = await prisma.team.update({
        where: { id: teamId },
        data: input,
      });
      if (input.name !== undefined && input.name !== existing.name) {
        await logActivity(prisma, {
          teamId,
          actorId,
          action: 'team.renamed',
          meta: { oldName: existing.name, newName: input.name },
        });
      }
      return { ...team, myRole: 'MANAGER' };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError) {
        if (err.code === 'P2002') throw Errors.conflict('Slug already taken');
        if (err.code === 'P2025') throw Errors.notFound('Team not found');
      }
      throw err;
    }
  }

  // v1.48: manager-driven delete with dependency guard. Global admins may
  // pass force=true (Settings → Admin) to cascade-delete content.
  async delete(
    teamId: string,
    actorId: string,
    opts?: { force?: boolean },
  ): Promise<void> {
    const team = await prisma.team.findUnique({ where: { id: teamId } });
    if (!team) throw Errors.notFound('Team not found');

    const blockers = await this.getDeleteBlockers(teamId);
    if (!opts?.force && !blockers.canDelete) {
      throw Errors.conflict('Cannot delete team', blockers);
    }

    await logActivity(prisma, {
      teamId: null,
      actorId,
      action: 'team.deleted',
      meta: {
        teamId,
        teamName: team.name,
        teamSlug: team.slug,
        forced: !!opts?.force,
        projectCount: blockers.projectCount,
        taskCount: blockers.taskCount,
        memberCount: blockers.memberCount,
      },
    });

    try {
      await prisma.team.delete({ where: { id: teamId } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        throw Errors.notFound('Team not found');
      }
      throw err;
    }
  }

  async addMember(
    teamId: string,
    input: { email: string; role: TeamRole },
  ): Promise<TeamMemberView> {
    // Case-insensitive: LDAP JIT stores mail as returned by AD (often mixed
    // case) while addMemberBody lowercases the invite email.
    const user = await prisma.user.findFirst({
      where: { email: { equals: input.email, mode: 'insensitive' } },
    });
    if (!user) throw Errors.notFound('No user with that email');

    // v1.23: also look up the matching system role for the team so the new
    // membership lands with both `role` and `roleId` populated.
    const systemRole = await prisma.role.findFirst({
      where: { teamId, isSystem: true, name: input.role === 'MANAGER' ? 'Manager' : 'Member' },
    });

    try {
      const m = await prisma.teamMembership.create({
        data: {
          teamId,
          userId: user.id,
          role: input.role,
          ...(systemRole && { roleId: systemRole.id }),
        },
        include: { user: true, customRole: { select: { name: true } } },
      });
      return {
        userId: m.userId,
        email: m.user.email,
        name: m.user.name,
        role: m.role,
        roleId: m.roleId,
        roleName: m.customRole?.name ?? null,
        joinedAt: m.joinedAt,
      };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw Errors.conflict('User already a member of this team');
      }
      throw err;
    }
  }

  async removeMember(teamId: string, userId: string): Promise<void> {
    const membership = await prisma.teamMembership.findUnique({
      where: { userId_teamId: { userId, teamId } },
    });
    if (!membership) throw Errors.notFound('Member not found');

    // Block removing the last MANAGER — would orphan the team. Caller can
    // either promote someone else first or delete the team entirely.
    if (membership.role === 'MANAGER') {
      const managerCount = await prisma.teamMembership.count({
        where: { teamId, role: 'MANAGER' },
      });
      if (managerCount <= 1) throw Errors.conflict('Cannot remove the last MANAGER');
    }

    await prisma.teamMembership.delete({
      where: { userId_teamId: { userId, teamId } },
    });
  }

  // v1.23: accepts either the legacy `role` enum (for backwards compat) or
  // a `roleId` pointing at a custom Role row. Both update the same membership
  // — but when roleId is supplied, we ALSO sync the legacy enum to match the
  // system role family ("Manager" or "Member") so old code paths reading the
  // enum keep behaving sensibly until v1.24 drops them.
  async updateMemberRole(
    teamId: string,
    userId: string,
    input: { role?: TeamRole; roleId?: string },
  ): Promise<TeamMemberView> {
    const membership = await prisma.teamMembership.findUnique({
      where: { userId_teamId: { userId, teamId } },
      include: { user: true },
    });
    if (!membership) throw Errors.notFound('Member not found');

    // Resolve the final (role, roleId) pair.
    let newRole: TeamRole = membership.role;
    let newRoleId: string | null = membership.roleId;

    if (input.roleId !== undefined) {
      // Custom-role path.
      const target = await prisma.role.findUnique({ where: { id: input.roleId } });
      if (!target || target.teamId !== teamId) {
        throw Errors.badRequest('Role does not belong to this team');
      }
      newRoleId = target.id;
      // Mirror the system-role intent in the legacy enum so v1.18 / v1.21
      // gates that consult `membership.role` keep working. Custom roles
      // default to MEMBER for that purpose; admins are still bypassed.
      newRole = target.name === 'Manager' ? 'MANAGER' : 'MEMBER';
    } else if (input.role !== undefined) {
      // Legacy enum path. Map to the matching system role for the team.
      newRole = input.role;
      const systemRole = await prisma.role.findFirst({
        where: { teamId, isSystem: true, name: newRole === 'MANAGER' ? 'Manager' : 'Member' },
      });
      newRoleId = systemRole?.id ?? null;
    }

    // Same "last MANAGER" guard for demotion as for removal — applies whether
    // demotion comes via legacy enum or a custom role that maps to MEMBER.
    if (membership.role === 'MANAGER' && newRole !== 'MANAGER') {
      const managerCount = await prisma.teamMembership.count({
        where: { teamId, role: 'MANAGER' },
      });
      if (managerCount <= 1) throw Errors.conflict('Cannot demote the last MANAGER');
    }

    const updated = await prisma.teamMembership.update({
      where: { userId_teamId: { userId, teamId } },
      data: { role: newRole, roleId: newRoleId },
      include: {
        user: true,
        customRole: { select: { name: true } },
      },
    });
    return {
      userId: updated.userId,
      email: updated.user.email,
      name: updated.user.name,
      role: updated.role,
      roleId: updated.roleId,
      roleName: updated.customRole?.name ?? null,
      joinedAt: updated.joinedAt,
    };
  }
}

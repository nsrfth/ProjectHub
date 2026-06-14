import { Prisma, type GlobalRole, type TeamRole } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';
import type { Permission } from '../lib/permissions.js';
import { listMembershipPermissions } from '../middleware/requirePermission.js';
import { logActivity } from './activityLogger.js';
import { systemRoleIdFor } from '../lib/teamRoles.js';
import {
  assertNotSystemUserTarget,
  bootstrapSystemUserFlag,
  countHumanManagers,
  ensureSystemManagerOnTeam,
  filterVisibleMembers,
  getSystemUserId,
  isSystemUser,
  resolveTeamMembership,
  syncSystemUserMissingTeamMemberships,
} from '../lib/systemUser.js';

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
  disabled: boolean;
  locked: boolean;
  external: boolean;
  /** Set for external group accessors only — shows FULL vs READONLY access. */
  groupAccessLevel: 'FULL' | 'READONLY' | null;
}

function memberStatusFromUser(
  user: { disabledAt: Date | null; lockedUntil: Date | null },
  now = new Date(),
): Pick<TeamMemberView, 'disabled' | 'locked'> {
  return {
    disabled: user.disabledAt != null,
    locked: user.lockedUntil != null && user.lockedUntil > now,
  };
}

function membershipToView(
  m: {
    userId: string;
    role: TeamRole;
    roleId: string | null;
    joinedAt: Date;
    user: { email: string; name: string; disabledAt: Date | null; lockedUntil: Date | null };
    customRole?: { name: string } | null;
  },
  now = new Date(),
): TeamMemberView {
  return {
    userId: m.userId,
    email: m.user.email,
    name: m.user.name,
    role: m.role,
    roleId: m.roleId,
    roleName: m.customRole?.name ?? null,
    joinedAt: m.joinedAt,
    ...memberStatusFromUser(m.user, now),
    external: false,
    groupAccessLevel: null,
  };
}

export interface TeamCapabilities {
  editDetails: boolean;
  deleteTeam: boolean;
  manageGroups: boolean;
}

export interface TeamDeleteBlockers {
  canDelete: boolean;
  projectCount: number;
  taskCount: number;
  memberCount: number;
  reasons: string[];
}

export interface MemberRemovalProjectRef {
  id: string;
  name: string;
}

export interface TeamMemberRemovalBlockers {
  canRemove: boolean;
  ownedProjectCount: number;
  accountableProjectCount: number;
  ownedProjects: MemberRemovalProjectRef[];
  accountableProjects: MemberRemovalProjectRef[];
  reasons: string[];
}

export interface RemoveMemberOpts {
  reassignOwnerTo?: string;
  force?: boolean;
}

export interface PagedResult<T> {
  items: T[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export interface ListTeamMembersOpts {
  page: number;
  pageSize: number;
  search?: string;
  role?: TeamRole;
  status?: 'active' | 'disabled' | 'locked';
  kind?: 'member' | 'external' | 'all';
  sortBy?: 'name' | 'email' | 'joinedAt' | 'role';
  sortDir?: 'asc' | 'desc';
}

function clampTeamMemberPageSize(pageSize: number): number {
  if (!Number.isFinite(pageSize) || pageSize <= 0) return 25;
  return Math.min(100, Math.max(10, pageSize));
}

async function fetchFullTeamRoster(teamId: string): Promise<TeamMemberView[]> {
  const systemUserId = await getSystemUserId();
  const now = new Date();

  const memberships = await prisma.teamMembership.findMany({
    where: { teamId, user: { isSystemUser: false } },
    include: { user: true, customRole: { select: { name: true } } },
    orderBy: { joinedAt: 'asc' },
  });

  const teamMemberRows = memberships.map((m) => membershipToView(m, now));
  const memberUserIds = new Set(teamMemberRows.map((m) => m.userId));

  const excludeExternalIds = [...memberUserIds];
  if (systemUserId) excludeExternalIds.push(systemUserId);

  const externalGroupRows = await prisma.userGroupMember.findMany({
    where: {
      status: 'ACCEPTED',
      group: { teamId },
      userId: { notIn: excludeExternalIds },
      user: { isSystemUser: false },
    },
    include: { user: true },
    orderBy: { invitedAt: 'asc' },
  });

  const externalByUser = new Map<string, (typeof externalGroupRows)[number]>();
  for (const row of externalGroupRows) {
    if (isSystemUser(row.user)) continue;
    const existing = externalByUser.get(row.userId);
    if (!existing || (row.accessLevel === 'FULL' && existing.accessLevel === 'READONLY')) {
      externalByUser.set(row.userId, row);
    }
  }

  const externalMemberRows: TeamMemberView[] = [...externalByUser.values()].map((row) => ({
    userId: row.userId,
    email: row.user.email,
    name: row.user.name,
    role: 'MEMBER' as TeamRole,
    roleId: null,
    roleName: null,
    joinedAt: row.respondedAt ?? row.invitedAt,
    ...memberStatusFromUser(row.user, now),
    external: true,
    groupAccessLevel: row.accessLevel,
  }));

  return filterVisibleMembers([...teamMemberRows, ...externalMemberRows], systemUserId);
}

function filterAndSortRoster(
  rows: TeamMemberView[],
  opts: ListTeamMembersOpts,
): TeamMemberView[] {
  let out = rows;

  const search = opts.search?.trim();
  if (search) {
    const q = search.toLowerCase();
    out = out.filter(
      (m) => m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q),
    );
  }

  if (opts.role) {
    out = out.filter((m) => !m.external && m.role === opts.role);
  }

  if (opts.kind === 'member') {
    out = out.filter((m) => !m.external);
  } else if (opts.kind === 'external') {
    out = out.filter((m) => m.external);
  }

  if (opts.status === 'disabled') {
    out = out.filter((m) => m.disabled);
  } else if (opts.status === 'locked') {
    out = out.filter((m) => m.locked);
  } else if (opts.status === 'active') {
    out = out.filter((m) => !m.disabled && !m.locked);
  }

  const dir = opts.sortDir === 'desc' ? -1 : 1;
  const sortBy = opts.sortBy ?? 'joinedAt';

  return [...out].sort((a, b) => {
    let cmp = 0;
    switch (sortBy) {
      case 'name':
        cmp = a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
        break;
      case 'email':
        cmp = a.email.localeCompare(b.email, 'en', { sensitivity: 'base' });
        break;
      case 'role':
        cmp = a.role.localeCompare(b.role);
        break;
      default:
        cmp = a.joinedAt.getTime() - b.joinedAt.getTime();
    }
    if (cmp !== 0) return cmp * dir;
    if (a.external !== b.external) return a.external ? 1 : -1;
    return a.userId.localeCompare(b.userId);
  });
}

function paginateRoster(
  rows: TeamMemberView[],
  page: number,
  pageSize: number,
): PagedResult<TeamMemberView> {
  const safePage = Math.max(1, page);
  const safePageSize = clampTeamMemberPageSize(pageSize);
  const totalItems = rows.length;
  const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / safePageSize);
  const items = rows.slice((safePage - 1) * safePageSize, safePage * safePageSize);
  return { items, page: safePage, pageSize: safePageSize, totalItems, totalPages };
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
      await bootstrapSystemUserFlag();
      await ensureSystemManagerOnTeam(team.id);
      const managerRoleId = await systemRoleIdFor(team.id, 'MANAGER');
      await prisma.teamMembership.update({
        where: { userId_teamId: { userId: creatorId, teamId: team.id } },
        data: { roleId: managerRoleId },
      });
      await logActivity(prisma, {
        actorId: null,
        teamId: team.id,
        action: 'system.manager_assigned',
        meta: { reason: 'team_created' },
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

  async listMine(userId: string, globalRole: GlobalRole = 'MEMBER'): Promise<TeamWithRole[]> {
    await syncSystemUserMissingTeamMemberships(userId);

    if (globalRole === 'ADMIN') {
      const teams = await prisma.team.findMany({ orderBy: { createdAt: 'asc' } });
      const memberships = await prisma.teamMembership.findMany({
        where: { userId },
        select: { teamId: true, role: true },
      });
      const roleByTeam = new Map(memberships.map((m) => [m.teamId, m.role]));
      return teams.map((t) => ({
        id: t.id,
        name: t.name,
        slug: t.slug,
        color: t.color,
        createdAt: t.createdAt,
        myRole: roleByTeam.get(t.id) ?? 'MANAGER',
      }));
    }

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
    const { team, capabilities, deleteBlockers } = await this.loadTeamContext(
      userId,
      teamId,
      globalRole,
    );

    // Compat: embed the first page of the paged roster (default sort/filter).
    const firstPage = paginateRoster(
      filterAndSortRoster(await fetchFullTeamRoster(teamId), {
        page: 1,
        pageSize: 25,
        kind: 'all',
        sortBy: 'joinedAt',
        sortDir: 'asc',
      }),
      1,
      25,
    );

    return {
      team,
      members: firstPage.items,
      capabilities,
      deleteBlockers,
    };
  }

  /**
   * Paged team roster — team members and external group accessors merged,
   * filtered, sorted together, then paginated. Default sort: joinedAt asc.
   */
  async listTeamMembers(
    userId: string,
    teamId: string,
    globalRole: GlobalRole,
    opts: ListTeamMembersOpts,
  ): Promise<PagedResult<TeamMemberView>> {
    await this.loadTeamContext(userId, teamId, globalRole);
    const roster = await fetchFullTeamRoster(teamId);
    const filtered = filterAndSortRoster(roster, opts);
    return paginateRoster(filtered, opts.page, opts.pageSize);
  }

  private async loadTeamContext(
    userId: string,
    teamId: string,
    globalRole: GlobalRole,
  ): Promise<{
    team: TeamWithRole;
    capabilities: TeamCapabilities;
    deleteBlockers: TeamDeleteBlockers | null;
  }> {
    const team = await prisma.team.findUnique({ where: { id: teamId } });
    if (!team) throw Errors.notFound('Team not found');

    let myMembership = await resolveTeamMembership(userId, teamId);
    if (!myMembership && globalRole === 'ADMIN') {
      myMembership = {
        id: 'admin-bypass',
        userId,
        teamId,
        role: 'MANAGER',
        roleId: null,
        joinedAt: new Date(0),
      };
    }
    if (!myMembership) throw Errors.forbidden('Not a team member');

    const perms = await listMembershipPermissions(myMembership, globalRole);
    const capabilities: TeamCapabilities = {
      editDetails: permGranted(perms, 'team.edit_details'),
      deleteTeam: permGranted(perms, 'team.delete'),
      manageGroups: permGranted(perms, 'group.manage'),
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
      capabilities,
      deleteBlockers,
    };
  }

  async getDeleteBlockers(teamId: string): Promise<TeamDeleteBlockers> {
    const systemUserId = await getSystemUserId();
    const [projectCount, taskCount, memberCount] = await Promise.all([
      prisma.project.count({ where: { teamId } }),
      prisma.task.count({ where: { teamId, deletedAt: null } }),
      prisma.teamMembership.count({
        where: {
          teamId,
          ...(systemUserId ? { userId: { not: systemUserId } } : {}),
        },
      }),
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
    if (isSystemUser(user)) throw Errors.conflict('This account is managed by the system');

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
      return membershipToView(m);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw Errors.conflict('User already a member of this team');
      }
      throw err;
    }
  }

  async getMemberRemovalBlockers(
    teamId: string,
    userId: string,
  ): Promise<TeamMemberRemovalBlockers> {
    const membership = await prisma.teamMembership.findUnique({
      where: { userId_teamId: { userId, teamId } },
    });
    if (!membership) throw Errors.notFound('Member not found');

    const [ownedProjects, accountableProjects] = await Promise.all([
      prisma.project.findMany({
        where: { teamId, ownerId: userId },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
        take: 20,
      }),
      prisma.project.findMany({
        where: { teamId, accountableId: userId, ownerId: { not: userId } },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
        take: 20,
      }),
    ]);

    const [ownedProjectCount, accountableProjectCount] = await Promise.all([
      prisma.project.count({ where: { teamId, ownerId: userId } }),
      prisma.project.count({
        where: { teamId, accountableId: userId, ownerId: { not: userId } },
      }),
    ]);

    const reasons: string[] = [];
    if (ownedProjectCount > 0) {
      reasons.push(
        `User owns ${ownedProjectCount} project${ownedProjectCount === 1 ? '' : 's'} in this team`,
      );
    }
    if (accountableProjectCount > 0) {
      reasons.push(
        `User is accountable for ${accountableProjectCount} project${accountableProjectCount === 1 ? '' : 's'} in this team`,
      );
    }

    return {
      canRemove: ownedProjectCount === 0,
      ownedProjectCount,
      accountableProjectCount,
      ownedProjects: ownedProjects.map((p) => ({ id: p.id, name: p.name })),
      accountableProjects: accountableProjects.map((p) => ({ id: p.id, name: p.name })),
      reasons,
    };
  }

  async removeMember(
    teamId: string,
    userId: string,
    opts?: RemoveMemberOpts,
    actorId?: string | null,
  ): Promise<void> {
    await assertNotSystemUserTarget(userId, 'Cannot remove the system manager');

    const membership = await prisma.teamMembership.findUnique({
      where: { userId_teamId: { userId, teamId } },
    });
    if (!membership) throw Errors.notFound('Member not found');

    // Block removing the last human MANAGER — runs before ownership checks.
    if (membership.role === 'MANAGER') {
      const humanManagers = await countHumanManagers(teamId);
      if (humanManagers <= 1) throw Errors.conflict('Cannot remove the last MANAGER');
    }

    const blockers = await this.getMemberRemovalBlockers(teamId, userId);

    if (blockers.ownedProjectCount > 0) {
      if (opts?.reassignOwnerTo) {
        if (opts.reassignOwnerTo === userId) {
          throw Errors.badRequest('Cannot reassign ownership to the member being removed');
        }
        const targetMembership = await prisma.teamMembership.findUnique({
          where: { userId_teamId: { userId: opts.reassignOwnerTo, teamId } },
        });
        if (!targetMembership) {
          throw Errors.badRequest('Reassignment target is not a member of this team');
        }

        const ownedIds = await prisma.project.findMany({
          where: { teamId, ownerId: userId },
          select: { id: true },
        });
        if (ownedIds.length > 0) {
          await prisma.project.updateMany({
            where: { teamId, ownerId: userId },
            data: { ownerId: opts.reassignOwnerTo },
          });
          await logActivity(prisma, {
            teamId,
            actorId: actorId ?? null,
            action: 'project.owner_reassigned',
            meta: {
              fromUserId: userId,
              toUserId: opts.reassignOwnerTo,
              projectIds: ownedIds.map((p) => p.id),
              reason: 'team_member_removed',
            },
          });
        }
      } else if (!opts?.force) {
        throw Errors.conflict('Cannot remove member who owns team projects', blockers);
      }
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
    await assertNotSystemUserTarget(userId, 'Cannot change the system manager role');

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
      const humanManagers = await countHumanManagers(teamId);
      if (humanManagers <= 1) throw Errors.conflict('Cannot demote the last MANAGER');
    }

    const updated = await prisma.teamMembership.update({
      where: { userId_teamId: { userId, teamId } },
      data: { role: newRole, roleId: newRoleId },
      include: {
        user: true,
        customRole: { select: { name: true } },
      },
    });
    return membershipToView(updated);
  }
}

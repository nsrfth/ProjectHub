import type { GroupAccessLevel, GroupInviteStatus, GroupRole, UserGroupKind } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { searchUsers as searchUsersLib } from '../lib/userSearch.js';
import { Errors } from '../lib/errors.js';
import { logActivity } from './activityLogger.js';
import { notificationsHub } from './notificationsHub.js';

export interface UserGroupSummary {
  id: string;
  teamId: string;
  name: string;
  description: string | null;
  // v2.6 (Phase 1A): UNIT (AD-synced section, direct membership, one per
  // person per team) or COLLAB (the shipped invitation-based behaviour).
  kind: UserGroupKind;
  memberCount: number;
  grantedProjectCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserGroupMemberView {
  id: string;
  userId: string;
  email: string;
  name: string;
  accessLevel: GroupAccessLevel;
  status: GroupInviteStatus;
  external: boolean;
  // v2.6 (Phase 1A): standing within the group. A UNIT's MANAGER is the
  // supervisor; on COLLAB groups it is informational for now.
  role: GroupRole;
  invitedAt: Date;
  respondedAt: Date | null;
}

export interface UserGroupProjectView {
  projectId: string;
  name: string;
  ownerId: string | null;
  grantedAt: Date;
}

export interface UserGroupDetail extends UserGroupSummary {
  members: UserGroupMemberView[];
  projects: UserGroupProjectView[];
}

export interface GroupInviteView {
  id: string;
  groupId: string;
  groupName: string;
  teamId: string;
  teamName: string;
  accessLevel: GroupAccessLevel;
  invitedAt: Date;
  invitedByName: string | null;
}

async function assertGroupInTeam(teamId: string, groupId: string) {
  const g = await prisma.userGroup.findUnique({ where: { id: groupId } });
  if (!g || g.teamId !== teamId) throw Errors.notFound('Group not found');
  return g;
}

async function assertProjectsInTeam(teamId: string, projectIds: string[]): Promise<void> {
  if (!projectIds.length) return;
  const count = await prisma.project.count({
    where: { teamId, id: { in: projectIds } },
  });
  if (count !== projectIds.length) throw Errors.notFound('Project not found');
}

async function isTeamMember(teamId: string, userId: string): Promise<boolean> {
  const m = await prisma.teamMembership.findUnique({
    where: { userId_teamId: { userId, teamId } },
  });
  return !!m;
}

async function emitGroupInviteNotification(
  inviteeId: string,
  teamId: string,
  payload: Prisma.InputJsonValue,
): Promise<void> {
  try {
    await prisma.notification.create({
      data: { userId: inviteeId, teamId, type: 'GROUP_INVITE', payload },
    });
    notificationsHub.publish(inviteeId, { type: 'notification:new', id: '' });
  } catch {
    // best-effort
  }
}

function toSummary(
  g: {
    id: string;
    teamId: string;
    name: string;
    description: string | null;
    kind: UserGroupKind;
    createdAt: Date;
    updatedAt: Date;
    _count: { members: number; grants: number };
  },
): UserGroupSummary {
  return {
    id: g.id,
    teamId: g.teamId,
    name: g.name,
    description: g.description,
    kind: g.kind,
    memberCount: g._count.members,
    grantedProjectCount: g._count.grants,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
  };
}

/**
 * v2.6 (Phase 1A): translate the one-unit-per-person partial-index violation
 * into a friendly 409.
 *
 * Deliberately does NOT inspect `err.meta.target`: the index lives in raw
 * migration SQL, not the Prisma schema, so Prisma cannot map the constraint
 * name back to fields and the meta shape is version-dependent (verified on the
 * LAN box — target came back as the column list, not the index name). Instead
 * the CALLER asserts the context: inside addMember the (groupId, userId)
 * duplicate is pre-checked, so any P2002 on a UNIT insert can only be the
 * one-unit index.
 */
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export class UserGroupsService {
  async list(teamId: string): Promise<UserGroupSummary[]> {
    const rows = await prisma.userGroup.findMany({
      where: { teamId },
      orderBy: { name: 'asc' },
      include: { _count: { select: { members: true, grants: true } } },
    });
    return rows.map(toSummary);
  }

  async searchUsers(query: string, limit = 20): Promise<Array<{ id: string; email: string; name: string }>> {
    return searchUsersLib(query, limit);
  }

  async create(
    teamId: string,
    actorId: string,
    input: { name: string; description?: string | null; kind?: UserGroupKind },
  ): Promise<UserGroupSummary> {
    try {
      const g = await prisma.userGroup.create({
        data: {
          teamId,
          name: input.name.trim(),
          description: input.description?.trim() ?? null,
          // v2.6 (Phase 1A): defaults COLLAB — existing callers unchanged.
          kind: input.kind ?? 'COLLAB',
        },
        include: { _count: { select: { members: true, grants: true } } },
      });
      await logActivity(prisma, {
        actorId,
        teamId,
        action: 'group.created',
        meta: { groupId: g.id, name: g.name, kind: g.kind },
      });
      return toSummary(g);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw Errors.conflict('A group with this name already exists on the team');
      }
      throw err;
    }
  }

  async get(teamId: string, groupId: string): Promise<UserGroupDetail> {
    const g = await prisma.userGroup.findUnique({
      where: { id: groupId },
      include: {
        _count: { select: { members: true, grants: true } },
        members: {
          include: { user: { select: { email: true, name: true } } },
          orderBy: { invitedAt: 'asc' },
        },
        grants: {
          include: { project: { select: { id: true, name: true, ownerId: true } } },
          orderBy: { grantedAt: 'asc' },
        },
      },
    });
    if (!g || g.teamId !== teamId) throw Errors.notFound('Group not found');
    return {
      ...toSummary(g),
      members: g.members.map((m) => ({
        id: m.id,
        userId: m.userId,
        email: m.user.email,
        name: m.user.name,
        accessLevel: m.accessLevel,
        status: m.status,
        external: m.external,
        role: m.role,
        invitedAt: m.invitedAt,
        respondedAt: m.respondedAt,
      })),
      projects: g.grants.map((gr) => ({
        projectId: gr.project.id,
        name: gr.project.name,
        ownerId: gr.project.ownerId,
        grantedAt: gr.grantedAt,
      })),
    };
  }

  async update(
    teamId: string,
    groupId: string,
    actorId: string,
    input: { name?: string; description?: string | null },
  ): Promise<UserGroupSummary> {
    await assertGroupInTeam(teamId, groupId);
    try {
      const g = await prisma.userGroup.update({
        where: { id: groupId },
        data: {
          ...(input.name !== undefined && { name: input.name.trim() }),
          ...(input.description !== undefined && {
            description: input.description?.trim() ?? null,
          }),
        },
        include: { _count: { select: { members: true, grants: true } } },
      });
      await logActivity(prisma, {
        actorId,
        teamId,
        action: 'group.updated',
        meta: { groupId, name: g.name },
      });
      return toSummary(g);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw Errors.conflict('A group with this name already exists on the team');
      }
      throw err;
    }
  }

  async remove(teamId: string, groupId: string, actorId: string): Promise<void> {
    const g = await assertGroupInTeam(teamId, groupId);
    await prisma.userGroup.delete({ where: { id: groupId } });
    await logActivity(prisma, {
      actorId,
      teamId,
      action: 'group.deleted',
      meta: { groupId, name: g.name },
    });
  }

  /**
   * COLLAB: in-team members ACCEPTED directly, out-of-team get a PENDING
   * invite (the v1.51 behaviour, unchanged).
   *
   * UNIT (v2.6, Phase 1A): direct membership only — a unit is an org fact, not
   * an invitation. Members must belong to the team (a section cannot contain
   * someone outside its department), accessLevel is pinned FULL (unit
   * membership IS full participation; a read-only unit member is a
   * contradiction the model rejects rather than stores), and the single-unit
   * partial index may veto the insert if the person already holds a unit.
   */
  async addMember(
    teamId: string,
    groupId: string,
    actorId: string,
    userId: string,
    accessLevel: GroupAccessLevel,
    role: GroupRole = 'MEMBER',
  ): Promise<UserGroupDetail> {
    const group = await assertGroupInTeam(teamId, groupId);
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.disabledAt) throw Errors.notFound('User not found');

    const inTeam = await isTeamMember(teamId, userId);
    const isUnit = group.kind === 'UNIT';
    if (isUnit && !inTeam) {
      throw Errors.badRequest(
        'Units contain team members only — add the person to the team first',
      );
    }
    const external = !inTeam;
    const effectiveAccess: GroupAccessLevel = isUnit ? 'FULL' : accessLevel;

    const existing = await prisma.userGroupMember.findUnique({
      where: { groupId_userId: { groupId, userId } },
    });
    if (existing) {
      if (existing.status === 'DECLINED') {
        throw Errors.conflict('User previously declined this invitation');
      }
      throw Errors.conflict('User is already in this group');
    }

    let member;
    try {
      member = await prisma.userGroupMember.create({
        data: {
          groupId,
          userId,
          accessLevel: effectiveAccess,
          // Units never create PENDING rows — there is no invite to accept.
          status: external ? 'PENDING' : 'ACCEPTED',
          external,
          role,
          invitedById: actorId,
          respondedAt: external ? null : new Date(),
        },
        include: {
          user: { select: { name: true, email: true } },
          group: { include: { team: { select: { name: true } } } },
        },
      });
    } catch (err) {
      // Same-group duplicates were pre-checked above, so a unique violation on
      // a UNIT insert can only be the one-unit-per-team partial index.
      if (isUnit && isUniqueViolation(err)) {
        throw Errors.conflict(
          `${user.name} already belongs to a unit in this team — a person holds exactly one unit. Remove them from their current unit first.`,
        );
      }
      throw err;
    }

    if (external) {
      const team = await prisma.team.findUnique({ where: { id: teamId }, select: { name: true } });
      const inviter = await prisma.user.findUnique({ where: { id: actorId }, select: { name: true } });
      await emitGroupInviteNotification(userId, teamId, {
        memberId: member.id,
        groupId,
        groupName: group.name,
        teamId,
        teamName: team?.name ?? '',
        accessLevel,
        invitedByName: inviter?.name ?? null,
      });
      await logActivity(prisma, {
        actorId,
        teamId,
        action: 'group.member_invited',
        meta: { groupId, userId, accessLevel, external: true },
      });
    } else {
      await logActivity(prisma, {
        actorId,
        teamId,
        action: 'group.member_added',
        meta: { groupId, userId, accessLevel, external: false },
      });
    }

    return this.get(teamId, groupId);
  }

  async updateMemberAccess(
    teamId: string,
    groupId: string,
    userId: string,
    actorId: string,
    accessLevel: GroupAccessLevel,
  ): Promise<UserGroupDetail> {
    const group = await assertGroupInTeam(teamId, groupId);
    // v2.6 (Phase 1A): unit accessLevel is pinned FULL — see addMember.
    if (group.kind === 'UNIT' && accessLevel !== 'FULL') {
      throw Errors.badRequest('Unit members always have FULL access — units do not carry access levels');
    }
    try {
      await prisma.userGroupMember.update({
        where: { groupId_userId: { groupId, userId } },
        data: { accessLevel },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        throw Errors.notFound('Group member not found');
      }
      throw err;
    }
    await logActivity(prisma, {
      actorId,
      teamId,
      action: 'group.member_accessLevel_changed',
      meta: { groupId, userId, accessLevel },
    });
    return this.get(teamId, groupId);
  }

  /**
   * v2.6 (Phase 1A): set a member's role within the group. On a UNIT this
   * designates the supervisor — the person Phase 3's participation-acceptance
   * flow will route to. Kept as its own method (not folded into
   * updateMemberAccess) because role and access are different axes and a UNIT
   * rejects access changes while accepting role changes.
   */
  async updateMemberRole(
    teamId: string,
    groupId: string,
    userId: string,
    actorId: string,
    role: GroupRole,
  ): Promise<UserGroupDetail> {
    await assertGroupInTeam(teamId, groupId);
    try {
      await prisma.userGroupMember.update({
        where: { groupId_userId: { groupId, userId } },
        data: { role },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        throw Errors.notFound('Group member not found');
      }
      throw err;
    }
    await logActivity(prisma, {
      actorId,
      teamId,
      action: 'group.member_role_changed',
      meta: { groupId, userId, role },
    });
    return this.get(teamId, groupId);
  }

  async removeMember(
    teamId: string,
    groupId: string,
    userId: string,
    actorId: string,
  ): Promise<void> {
    await assertGroupInTeam(teamId, groupId);
    try {
      await prisma.userGroupMember.delete({
        where: { groupId_userId: { groupId, userId } },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        throw Errors.notFound('Group member not found');
      }
      throw err;
    }
    await logActivity(prisma, {
      actorId,
      teamId,
      action: 'group.member_removed',
      meta: { groupId, userId },
    });
  }

  async setProjects(
    teamId: string,
    groupId: string,
    actorId: string,
    projectIds: string[],
  ): Promise<UserGroupDetail> {
    await assertGroupInTeam(teamId, groupId);
    const unique = [...new Set(projectIds)];
    await assertProjectsInTeam(teamId, unique);
    await prisma.$transaction(async (tx) => {
      await tx.projectGroupGrant.deleteMany({ where: { groupId } });
      if (unique.length) {
        await tx.projectGroupGrant.createMany({
          data: unique.map((projectId) => ({ projectId, groupId })),
        });
      }
    });
    await logActivity(prisma, {
      actorId,
      teamId,
      action: 'group.projects_set',
      meta: { groupId, projectIds: unique },
    });
    return this.get(teamId, groupId);
  }

  async listPendingInvites(userId: string): Promise<GroupInviteView[]> {
    const rows = await prisma.userGroupMember.findMany({
      where: { userId, status: 'PENDING' },
      include: {
        group: { include: { team: { select: { name: true } } } },
        invitedBy: { select: { name: true } },
      },
      orderBy: { invitedAt: 'desc' },
    });
    return rows.map((r) => ({
      id: r.id,
      groupId: r.groupId,
      groupName: r.group.name,
      teamId: r.group.teamId,
      teamName: r.group.team.name,
      accessLevel: r.accessLevel,
      invitedAt: r.invitedAt,
      invitedByName: r.invitedBy?.name ?? null,
    }));
  }

  async acceptInvite(userId: string, memberId: string): Promise<void> {
    const row = await prisma.userGroupMember.findUnique({ where: { id: memberId } });
    if (!row || row.userId !== userId) throw Errors.notFound('Invitation not found');
    if (row.status !== 'PENDING') throw Errors.badRequest('Invitation is not pending');
    await prisma.userGroupMember.update({
      where: { id: memberId },
      data: { status: 'ACCEPTED', respondedAt: new Date() },
    });
    await logActivity(prisma, {
      actorId: userId,
      teamId: (await prisma.userGroup.findUnique({ where: { id: row.groupId } }))!.teamId,
      action: 'group.invite_accepted',
      meta: { groupId: row.groupId, memberId, external: row.external },
    });
  }

  async declineInvite(userId: string, memberId: string): Promise<void> {
    const row = await prisma.userGroupMember.findUnique({ where: { id: memberId } });
    if (!row || row.userId !== userId) throw Errors.notFound('Invitation not found');
    if (row.status !== 'PENDING') throw Errors.badRequest('Invitation is not pending');
    await prisma.userGroupMember.update({
      where: { id: memberId },
      data: { status: 'DECLINED', respondedAt: new Date() },
    });
    const group = await prisma.userGroup.findUnique({ where: { id: row.groupId } });
    await logActivity(prisma, {
      actorId: userId,
      teamId: group!.teamId,
      action: 'group.invite_declined',
      meta: { groupId: row.groupId, memberId, external: row.external },
    });
  }
}

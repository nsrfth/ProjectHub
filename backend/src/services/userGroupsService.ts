import type { GroupAccessLevel, GroupInviteStatus } from '@prisma/client';
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
    memberCount: g._count.members,
    grantedProjectCount: g._count.grants,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
  };
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
    input: { name: string; description?: string | null },
  ): Promise<UserGroupSummary> {
    try {
      const g = await prisma.userGroup.create({
        data: {
          teamId,
          name: input.name.trim(),
          description: input.description?.trim() ?? null,
        },
        include: { _count: { select: { members: true, grants: true } } },
      });
      await logActivity(prisma, {
        actorId,
        teamId,
        action: 'group.created',
        meta: { groupId: g.id, name: g.name },
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

  /** In-team members: ACCEPTED directly. Out-of-team: PENDING invite. */
  async addMember(
    teamId: string,
    groupId: string,
    actorId: string,
    userId: string,
    accessLevel: GroupAccessLevel,
  ): Promise<UserGroupDetail> {
    const group = await assertGroupInTeam(teamId, groupId);
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.disabledAt) throw Errors.notFound('User not found');

    const inTeam = await isTeamMember(teamId, userId);
    const external = !inTeam;

    const existing = await prisma.userGroupMember.findUnique({
      where: { groupId_userId: { groupId, userId } },
    });
    if (existing) {
      if (existing.status === 'DECLINED') {
        throw Errors.conflict('User previously declined this invitation');
      }
      throw Errors.conflict('User is already in this group');
    }

    const member = await prisma.userGroupMember.create({
      data: {
        groupId,
        userId,
        accessLevel,
        status: external ? 'PENDING' : 'ACCEPTED',
        external,
        invitedById: actorId,
        respondedAt: external ? null : new Date(),
      },
      include: {
        user: { select: { name: true, email: true } },
        group: { include: { team: { select: { name: true } } } },
      },
    });

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
    await assertGroupInTeam(teamId, groupId);
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

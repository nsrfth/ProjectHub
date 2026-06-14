import { Prisma } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';
import { logActivity } from './activityLogger.js';

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
  userId: string;
  email: string;
  name: string;
  addedAt: Date;
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

async function assertGroupInTeam(teamId: string, groupId: string) {
  const g = await prisma.userGroup.findUnique({ where: { id: groupId } });
  if (!g || g.teamId !== teamId) throw Errors.notFound('Group not found');
  return g;
}

async function assertUsersAreTeamMembers(teamId: string, userIds: string[]): Promise<void> {
  if (!userIds.length) return;
  const count = await prisma.teamMembership.count({
    where: { teamId, userId: { in: userIds } },
  });
  if (count !== userIds.length) {
    throw Errors.badRequest('Every user must be a member of this team');
  }
}

async function assertProjectsInTeam(teamId: string, projectIds: string[]): Promise<void> {
  if (!projectIds.length) return;
  const count = await prisma.project.count({
    where: { teamId, id: { in: projectIds } },
  });
  if (count !== projectIds.length) throw Errors.notFound('Project not found');
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
          orderBy: { addedAt: 'asc' },
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
        userId: m.userId,
        email: m.user.email,
        name: m.user.name,
        addedAt: m.addedAt,
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

  async addMembers(
    teamId: string,
    groupId: string,
    actorId: string,
    userIds: string[],
  ): Promise<UserGroupDetail> {
    await assertGroupInTeam(teamId, groupId);
    const unique = [...new Set(userIds)];
    await assertUsersAreTeamMembers(teamId, unique);
    await prisma.userGroupMember.createMany({
      data: unique.map((userId) => ({ groupId, userId })),
      skipDuplicates: true,
    });
    await logActivity(prisma, {
      actorId,
      teamId,
      action: 'group.member_added',
      meta: { groupId, userIds: unique },
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
}

import { Prisma, type TeamRole } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';

// Business rules for teams + membership. Route layer enforces auth/RBAC and
// passes the caller's userId; this layer enforces invariants like
// "every team always has at least one MANAGER" so the team can never be orphaned.

export interface TeamWithRole {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
  myRole: TeamRole;
}

export interface TeamMemberView {
  userId: string;
  email: string;
  name: string;
  role: TeamRole;
  joinedAt: Date;
}

export class TeamsService {
  async create(
    creatorId: string,
    input: { name: string; slug: string },
  ): Promise<TeamWithRole> {
    try {
      const team = await prisma.team.create({
        data: {
          name: input.name,
          slug: input.slug,
          memberships: { create: { userId: creatorId, role: 'MANAGER' } },
        },
      });
      return {
        id: team.id,
        name: team.name,
        slug: team.slug,
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
      createdAt: m.team.createdAt,
      myRole: m.role,
    }));
  }

  async getDetail(
    userId: string,
    teamId: string,
  ): Promise<{ team: TeamWithRole; members: TeamMemberView[] }> {
    const team = await prisma.team.findUnique({
      where: { id: teamId },
      include: { memberships: { include: { user: true }, orderBy: { joinedAt: 'asc' } } },
    });
    if (!team) throw Errors.notFound('Team not found');

    const myMembership = team.memberships.find((m) => m.userId === userId);
    if (!myMembership) throw Errors.forbidden('Not a team member');

    return {
      team: {
        id: team.id,
        name: team.name,
        slug: team.slug,
        createdAt: team.createdAt,
        myRole: myMembership.role,
      },
      members: team.memberships.map((m) => ({
        userId: m.userId,
        email: m.user.email,
        name: m.user.name,
        role: m.role,
        joinedAt: m.joinedAt,
      })),
    };
  }

  async update(
    teamId: string,
    input: { name?: string; slug?: string },
  ): Promise<TeamWithRole & { myRole: TeamRole }> {
    if (input.name === undefined && input.slug === undefined) {
      throw Errors.badRequest('Provide at least one field to update');
    }
    try {
      const team = await prisma.team.update({
        where: { id: teamId },
        data: input,
      });
      // myRole is not returned here because update is gated on MANAGER already.
      return { ...team, myRole: 'MANAGER' };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError) {
        if (err.code === 'P2002') throw Errors.conflict('Slug already taken');
        if (err.code === 'P2025') throw Errors.notFound('Team not found');
      }
      throw err;
    }
  }

  async addMember(
    teamId: string,
    input: { email: string; role: TeamRole },
  ): Promise<TeamMemberView> {
    const user = await prisma.user.findUnique({ where: { email: input.email } });
    if (!user) throw Errors.notFound('No user with that email');

    try {
      const m = await prisma.teamMembership.create({
        data: { teamId, userId: user.id, role: input.role },
        include: { user: true },
      });
      return {
        userId: m.userId,
        email: m.user.email,
        name: m.user.name,
        role: m.role,
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

  async updateMemberRole(
    teamId: string,
    userId: string,
    newRole: TeamRole,
  ): Promise<TeamMemberView> {
    const membership = await prisma.teamMembership.findUnique({
      where: { userId_teamId: { userId, teamId } },
      include: { user: true },
    });
    if (!membership) throw Errors.notFound('Member not found');

    // Same "last MANAGER" guard for demotion as for removal.
    if (membership.role === 'MANAGER' && newRole !== 'MANAGER') {
      const managerCount = await prisma.teamMembership.count({
        where: { teamId, role: 'MANAGER' },
      });
      if (managerCount <= 1) throw Errors.conflict('Cannot demote the last MANAGER');
    }

    const updated = await prisma.teamMembership.update({
      where: { userId_teamId: { userId, teamId } },
      data: { role: newRole },
      include: { user: true },
    });
    return {
      userId: updated.userId,
      email: updated.user.email,
      name: updated.user.name,
      role: updated.role,
      joinedAt: updated.joinedAt,
    };
  }
}

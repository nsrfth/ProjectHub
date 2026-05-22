import { Prisma, type ProjectStatus, type TeamRole } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';

// Projects are always scoped to a team. The route layer establishes team
// membership via requireTeamRole before any service call, so we can trust
// teamId here without re-verifying. Owner-or-MANAGER is the only finer-grained
// check we still need for mutating individual projects.

export interface ProjectView {
  id: string;
  teamId: string;
  ownerId: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  createdAt: Date;
  updatedAt: Date;
}

export class ProjectsService {
  async create(
    teamId: string,
    ownerId: string,
    input: { name: string; description?: string },
  ): Promise<ProjectView> {
    const p = await prisma.project.create({
      data: {
        teamId,
        ownerId,
        name: input.name,
        description: input.description ?? null,
      },
    });
    return p;
  }

  async list(teamId: string): Promise<ProjectView[]> {
    return prisma.project.findMany({
      where: { teamId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(teamId: string, projectId: string): Promise<ProjectView> {
    const p = await prisma.project.findUnique({ where: { id: projectId } });
    // Same 404 whether the project doesn't exist or belongs to another team —
    // never leak the existence of resources across tenants.
    if (!p || p.teamId !== teamId) throw Errors.notFound('Project not found');
    return p;
  }

  async update(
    teamId: string,
    projectId: string,
    callerId: string,
    callerRole: TeamRole,
    input: { name?: string; description?: string | null; status?: ProjectStatus },
  ): Promise<ProjectView> {
    const existing = await this.get(teamId, projectId);
    // Owner can always edit; otherwise the caller must be a team MANAGER.
    if (existing.ownerId !== callerId && callerRole !== 'MANAGER') {
      throw Errors.forbidden('Only the project owner or a team MANAGER can edit this project');
    }
    try {
      return await prisma.project.update({
        where: { id: projectId },
        data: {
          ...(input.name !== undefined && { name: input.name }),
          ...(input.description !== undefined && { description: input.description }),
          ...(input.status !== undefined && { status: input.status }),
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        throw Errors.notFound('Project not found');
      }
      throw err;
    }
  }

  async remove(
    teamId: string,
    projectId: string,
    callerId: string,
    callerRole: TeamRole,
  ): Promise<void> {
    const existing = await this.get(teamId, projectId);
    if (existing.ownerId !== callerId && callerRole !== 'MANAGER') {
      throw Errors.forbidden('Only the project owner or a team MANAGER can delete this project');
    }
    await prisma.project.delete({ where: { id: projectId } });
  }
}

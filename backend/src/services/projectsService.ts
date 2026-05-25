import { Prisma, type GlobalRole, type ProjectStatus } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';
import { userHasPermission } from '../middleware/requirePermission.js';

// Projects are always scoped to a team. The route layer establishes team
// membership via requireTeamRole before any service call, so we can trust
// teamId here without re-verifying. Owner-or-MANAGER is the only finer-grained
// check we still need for mutating individual projects.

export interface ProjectView {
  id: string;
  teamId: string;
  // ownerId is null when the owning user has been deleted (FK SetNull).
  // A manager can reassign by transferring the project to a new owner.
  ownerId: string | null;
  // v1.17: RACI "Accountable" person. Same nullability story as ownerId.
  accountableId: string | null;
  accountableName: string | null;
  name: string;
  description: string | null;
  status: ProjectStatus;
  createdAt: Date;
  updatedAt: Date;
}

// Shape the Prisma row into a ProjectView. Centralised so list / get / update
// stay consistent and the accountable join lights up in every response.
function toView(
  p: Awaited<ReturnType<typeof prisma.project.findFirstOrThrow>> & {
    accountable?: { name: string } | null;
  },
): ProjectView {
  return {
    id: p.id,
    teamId: p.teamId,
    ownerId: p.ownerId,
    accountableId: p.accountableId ?? null,
    accountableName: p.accountable?.name ?? null,
    name: p.name,
    description: p.description,
    status: p.status,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

// v1.17: Accountable can be set only to a member of the same team. Skip the
// check when clearing (null). Throws 400 with a friendly message otherwise.
async function assertAccountableInTeam(
  teamId: string,
  accountableId: string | null,
): Promise<void> {
  if (accountableId === null) return;
  const membership = await prisma.teamMembership.findUnique({
    where: { userId_teamId: { userId: accountableId, teamId } },
    select: { userId: true },
  });
  if (!membership) {
    throw Errors.badRequest('Accountable user must be a member of this team');
  }
}

export class ProjectsService {
  async create(
    teamId: string,
    ownerId: string,
    input: { name: string; description?: string; accountableId?: string | null },
  ): Promise<ProjectView> {
    if (input.accountableId !== undefined) {
      await assertAccountableInTeam(teamId, input.accountableId);
    }
    const p = await prisma.project.create({
      data: {
        teamId,
        ownerId,
        accountableId: input.accountableId ?? null,
        name: input.name,
        description: input.description ?? null,
      },
      include: { accountable: { select: { name: true } } },
    });
    return toView(p);
  }

  async list(teamId: string): Promise<ProjectView[]> {
    const rows = await prisma.project.findMany({
      where: { teamId },
      orderBy: { createdAt: 'desc' },
      include: { accountable: { select: { name: true } } },
    });
    return rows.map(toView);
  }

  async get(teamId: string, projectId: string): Promise<ProjectView> {
    const p = await prisma.project.findUnique({
      where: { id: projectId },
      include: { accountable: { select: { name: true } } },
    });
    // Same 404 whether the project doesn't exist or belongs to another team —
    // never leak the existence of resources across tenants.
    if (!p || p.teamId !== teamId) throw Errors.notFound('Project not found');
    return toView(p);
  }

  async update(
    teamId: string,
    projectId: string,
    callerId: string,
    callerGlobalRole: GlobalRole,
    input: {
      name?: string;
      description?: string | null;
      status?: ProjectStatus;
      accountableId?: string | null;
    },
  ): Promise<ProjectView> {
    const existing = await this.get(teamId, projectId);
    // v1.23: owner can always edit their own project. Otherwise the caller
    // needs the `project.edit` permission. Setting accountableId narrows
    // further — it needs `project.set_accountable` even on top of edit.
    if (existing.ownerId !== callerId) {
      if (!(await userHasPermission(callerId, teamId, callerGlobalRole, 'project.edit'))) {
        throw Errors.forbidden('Missing permission: project.edit');
      }
    }
    if (input.accountableId !== undefined) {
      if (
        existing.ownerId !== callerId &&
        !(await userHasPermission(
          callerId,
          teamId,
          callerGlobalRole,
          'project.set_accountable',
        ))
      ) {
        throw Errors.forbidden('Missing permission: project.set_accountable');
      }
      await assertAccountableInTeam(teamId, input.accountableId);
    }
    try {
      const updated = await prisma.project.update({
        where: { id: projectId },
        data: {
          ...(input.name !== undefined && { name: input.name }),
          ...(input.description !== undefined && { description: input.description }),
          ...(input.status !== undefined && { status: input.status }),
          ...(input.accountableId !== undefined && { accountableId: input.accountableId }),
        },
        include: { accountable: { select: { name: true } } },
      });
      return toView(updated);
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
    callerGlobalRole: GlobalRole,
  ): Promise<void> {
    const existing = await this.get(teamId, projectId);
    if (existing.ownerId !== callerId) {
      if (!(await userHasPermission(callerId, teamId, callerGlobalRole, 'project.delete'))) {
        throw Errors.forbidden('Missing permission: project.delete');
      }
    }
    await prisma.project.delete({ where: { id: projectId } });
  }
}

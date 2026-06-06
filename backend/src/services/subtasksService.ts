import { Prisma, type GlobalRole } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';
import { userHasPermission } from '../middleware/requirePermission.js';

// Subtasks are checklist items inside a task. The route layer already verifies
// team membership; this service additionally enforces that the subtask belongs
// to the (teamId, projectId, taskId) chain in the URL, so cross-tenant probes
// return 404 instead of leaking existence.

const POSITION_GAP = 1000;

export interface SubtaskView {
  id: string;
  taskId: string;
  title: string;
  done: boolean;
  technicianId: string | null;
  technicianName: string | null;
  position: number;
}

const SUBTASK_INCLUDE = {
  technician: { select: { name: true } },
} as const;

function toView(row: Prisma.SubtaskGetPayload<{ include: typeof SUBTASK_INCLUDE }>): SubtaskView {
  return {
    id: row.id,
    taskId: row.taskId,
    title: row.title,
    done: row.done,
    technicianId: row.technicianId,
    technicianName: row.technician?.name ?? null,
    position: row.position,
  };
}

export class SubtasksService {
  private async ensureTaskInChain(teamId: string, projectId: string, taskId: string) {
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      select: { id: true, teamId: true, projectId: true },
    });
    if (!task || task.teamId !== teamId || task.projectId !== projectId) {
      throw Errors.notFound('Task not found');
    }
    return task;
  }

  async create(
    teamId: string,
    projectId: string,
    taskId: string,
    creatorId: string,
    input: { title: string; done?: boolean },
  ): Promise<SubtaskView> {
    await this.ensureTaskInChain(teamId, projectId, taskId);
    // Append to the end with the same sparse-position scheme as Task.
    const last = await prisma.subtask.findFirst({
      where: { taskId },
      orderBy: { position: 'desc' },
      select: { position: true },
    });
    const position = (last?.position ?? 0) + POSITION_GAP;
    const created = await prisma.subtask.create({
      data: {
        taskId,
        title: input.title,
        done: input.done ?? false,
        // v1.19: creator becomes the default technician (same rule as Task).
        technicianId: creatorId,
        position,
      },
      include: SUBTASK_INCLUDE,
    });
    return toView(created);
  }

  async update(
    teamId: string,
    projectId: string,
    taskId: string,
    subtaskId: string,
    actorId: string,
    actorGlobalRole: GlobalRole,
    input: { title?: string; done?: boolean; technicianId?: string | null },
  ): Promise<SubtaskView> {
    await this.ensureTaskInChain(teamId, projectId, taskId);
    const existing = await prisma.subtask.findUnique({ where: { id: subtaskId } });
    if (!existing || existing.taskId !== taskId) throw Errors.notFound('Subtask not found');

    // v1.19 → v1.23: technician change gate. Now permission-driven.
    if (input.technicianId !== undefined && input.technicianId !== existing.technicianId) {
      if (
        !(await userHasPermission(actorId, teamId, actorGlobalRole, 'task.change_technician'))
      ) {
        throw Errors.forbidden('Missing permission: task.change_technician');
      }
      if (input.technicianId !== null) {
        const membership = await prisma.teamMembership.findUnique({
          where: { userId_teamId: { userId: input.technicianId, teamId } },
        });
        if (!membership) throw Errors.badRequest('Technician is not a member of this team');
      }
    }

    try {
      const updated = await prisma.subtask.update({
        where: { id: subtaskId },
        data: {
          ...(input.title !== undefined && { title: input.title }),
          ...(input.done !== undefined && { done: input.done }),
          ...(input.technicianId !== undefined && { technicianId: input.technicianId }),
        },
        include: SUBTASK_INCLUDE,
      });
      return toView(updated);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        throw Errors.notFound('Subtask not found');
      }
      throw err;
    }
  }

  async remove(teamId: string, projectId: string, taskId: string, subtaskId: string): Promise<void> {
    await this.ensureTaskInChain(teamId, projectId, taskId);
    const existing = await prisma.subtask.findUnique({ where: { id: subtaskId } });
    if (!existing || existing.taskId !== taskId) throw Errors.notFound('Subtask not found');
    await prisma.subtask.delete({ where: { id: subtaskId } });
  }
}

import { Prisma } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';

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
  position: number;
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
    return prisma.subtask.create({
      data: {
        taskId,
        title: input.title,
        done: input.done ?? false,
        position,
      },
    });
  }

  async update(
    teamId: string,
    projectId: string,
    taskId: string,
    subtaskId: string,
    input: { title?: string; done?: boolean },
  ): Promise<SubtaskView> {
    await this.ensureTaskInChain(teamId, projectId, taskId);
    const existing = await prisma.subtask.findUnique({ where: { id: subtaskId } });
    if (!existing || existing.taskId !== taskId) throw Errors.notFound('Subtask not found');
    try {
      return await prisma.subtask.update({
        where: { id: subtaskId },
        data: {
          ...(input.title !== undefined && { title: input.title }),
          ...(input.done !== undefined && { done: input.done }),
        },
      });
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

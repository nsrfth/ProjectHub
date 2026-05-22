import { Prisma } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';

// Labels are team-scoped tags attached to tasks via TaskLabel. The route layer
// enforces team membership (requireTeamRole); within the team, any member can
// create/edit/delete labels and attach/detach — matches the "team collaborates
// on cards" philosophy used for tasks.

export interface LabelView {
  id: string;
  teamId: string;
  name: string;
  color: string;
}

export class LabelsService {
  async list(teamId: string): Promise<LabelView[]> {
    return prisma.label.findMany({
      where: { teamId },
      orderBy: { name: 'asc' },
    });
  }

  async create(teamId: string, input: { name: string; color: string }): Promise<LabelView> {
    try {
      return await prisma.label.create({ data: { teamId, name: input.name, color: input.color } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw Errors.conflict('A label with that name already exists in this team');
      }
      throw err;
    }
  }

  async update(
    teamId: string,
    labelId: string,
    input: { name?: string; color?: string },
  ): Promise<LabelView> {
    // 404 for cross-tenant probes — never leak existence of other teams' labels.
    const existing = await prisma.label.findUnique({ where: { id: labelId } });
    if (!existing || existing.teamId !== teamId) throw Errors.notFound('Label not found');
    try {
      return await prisma.label.update({
        where: { id: labelId },
        data: { ...(input.name !== undefined && { name: input.name }), ...(input.color !== undefined && { color: input.color }) },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw Errors.conflict('A label with that name already exists in this team');
      }
      throw err;
    }
  }

  async remove(teamId: string, labelId: string): Promise<void> {
    const existing = await prisma.label.findUnique({ where: { id: labelId } });
    if (!existing || existing.teamId !== teamId) throw Errors.notFound('Label not found');
    // TaskLabel rows cascade from Label, so detaching from tasks is automatic.
    await prisma.label.delete({ where: { id: labelId } });
  }

  // Attach is idempotent: if the label is already on the task, the second call
  // is a no-op (returns the same shape as the first).
  async attach(teamId: string, taskId: string, labelId: string): Promise<LabelView> {
    const label = await prisma.label.findUnique({ where: { id: labelId } });
    if (!label || label.teamId !== teamId) throw Errors.notFound('Label not found');

    // Confirm the task is in this team as well — same cross-tenant guard.
    const task = await prisma.task.findUnique({ where: { id: taskId }, select: { teamId: true } });
    if (!task || task.teamId !== teamId) throw Errors.notFound('Task not found');

    try {
      await prisma.taskLabel.create({ data: { taskId, labelId } });
    } catch (err) {
      // P2002 = already attached. Idempotent: swallow and return the label.
      if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') throw err;
    }
    return label;
  }

  async detach(teamId: string, taskId: string, labelId: string): Promise<void> {
    // Same cross-tenant guards as attach.
    const label = await prisma.label.findUnique({ where: { id: labelId } });
    if (!label || label.teamId !== teamId) throw Errors.notFound('Label not found');
    const task = await prisma.task.findUnique({ where: { id: taskId }, select: { teamId: true } });
    if (!task || task.teamId !== teamId) throw Errors.notFound('Task not found');

    // deleteMany so a missing row is a 0-count no-op rather than throwing P2025.
    await prisma.taskLabel.deleteMany({ where: { taskId, labelId } });
  }

  // Convenience: load labels attached to a task. Used by tasksService to
  // hydrate the task response.
  async listForTask(taskId: string): Promise<LabelView[]> {
    const rows = await prisma.taskLabel.findMany({
      where: { taskId },
      include: { label: true },
      orderBy: { label: { name: 'asc' } },
    });
    return rows.map((r) => r.label);
  }
}

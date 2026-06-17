import { Prisma } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';

// Labels are tags attached to tasks (TaskLabel) and projects (ProjectLabel).
// v1.80 splits them into two kinds:
//   - TEAM labels (teamId set) — user-defined, created/edited/deleted by any
//     team member. The original behaviour.
//   - GLOBAL "predefined" labels (teamId = NULL) — admin-managed, visible and
//     usable in EVERY team, read-only to members. Managed via /admin/labels.
// A team's label catalog (GET /teams/:teamId/labels) returns BOTH so the
// picker can offer predefined + the team's own.

export interface LabelView {
  id: string;
  teamId: string | null;
  name: string;
  color: string;
  isPredefined: boolean;
}

type LabelRow = { id: string; teamId: string | null; name: string; color: string };

function toView(row: LabelRow): LabelView {
  return {
    id: row.id,
    teamId: row.teamId,
    name: row.name,
    color: row.color,
    isPredefined: row.teamId === null,
  };
}

export class LabelsService {
  // Team catalog = this team's labels ∪ every global predefined label.
  // Predefined first, then the team's own, each alphabetical.
  async list(teamId: string): Promise<LabelView[]> {
    const rows = await prisma.label.findMany({
      where: { OR: [{ teamId }, { teamId: null }] },
      orderBy: { name: 'asc' },
    });
    const views = rows.map(toView);
    return views.sort((a, b) => {
      if (a.isPredefined !== b.isPredefined) return a.isPredefined ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
  }

  async create(teamId: string, input: { name: string; color: string }): Promise<LabelView> {
    try {
      const row = await prisma.label.create({
        data: { teamId, name: input.name, color: input.color },
      });
      return toView(row);
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
    // 404 for cross-tenant probes AND for globals — a team member can't edit a
    // predefined label through the team endpoint (its teamId is NULL ≠ teamId).
    const existing = await prisma.label.findUnique({ where: { id: labelId } });
    if (!existing || existing.teamId !== teamId) throw Errors.notFound('Label not found');
    try {
      const row = await prisma.label.update({
        where: { id: labelId },
        data: {
          ...(input.name !== undefined && { name: input.name }),
          ...(input.color !== undefined && { color: input.color }),
        },
      });
      return toView(row);
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
    // TaskLabel / ProjectLabel rows cascade from Label, so detaching is automatic.
    await prisma.label.delete({ where: { id: labelId } });
  }

  // Attach is idempotent. The label may be this team's own OR a global
  // predefined label (teamId NULL) — both are valid for a task in this team.
  async attach(teamId: string, taskId: string, labelId: string): Promise<LabelView> {
    const label = await prisma.label.findUnique({ where: { id: labelId } });
    if (!label || (label.teamId !== null && label.teamId !== teamId)) {
      throw Errors.notFound('Label not found');
    }

    // Confirm the task is in this team as well — same cross-tenant guard.
    const task = await prisma.task.findUnique({ where: { id: taskId }, select: { teamId: true } });
    if (!task || task.teamId !== teamId) throw Errors.notFound('Task not found');

    try {
      await prisma.taskLabel.create({ data: { taskId, labelId } });
    } catch (err) {
      // P2002 = already attached. Idempotent: swallow and return the label.
      if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') throw err;
    }
    return toView(label);
  }

  async detach(teamId: string, taskId: string, labelId: string): Promise<void> {
    // Same cross-tenant guards as attach (globals allowed).
    const label = await prisma.label.findUnique({ where: { id: labelId } });
    if (!label || (label.teamId !== null && label.teamId !== teamId)) {
      throw Errors.notFound('Label not found');
    }
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
    return rows.map((r) => toView(r.label));
  }

  // ── Global "predefined" labels (admin-managed; teamId = NULL) ──────────────

  async listGlobal(): Promise<LabelView[]> {
    const rows = await prisma.label.findMany({
      where: { teamId: null },
      orderBy: { name: 'asc' },
    });
    return rows.map(toView);
  }

  async createGlobal(input: { name: string; color: string }): Promise<LabelView> {
    try {
      const row = await prisma.label.create({
        data: { teamId: null, name: input.name, color: input.color },
      });
      return toView(row);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw Errors.conflict('A predefined label with that name already exists');
      }
      throw err;
    }
  }

  async updateGlobal(
    labelId: string,
    input: { name?: string; color?: string },
  ): Promise<LabelView> {
    const existing = await prisma.label.findUnique({ where: { id: labelId } });
    if (!existing || existing.teamId !== null) throw Errors.notFound('Predefined label not found');
    try {
      const row = await prisma.label.update({
        where: { id: labelId },
        data: {
          ...(input.name !== undefined && { name: input.name }),
          ...(input.color !== undefined && { color: input.color }),
        },
      });
      return toView(row);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw Errors.conflict('A predefined label with that name already exists');
      }
      throw err;
    }
  }

  async removeGlobal(labelId: string): Promise<void> {
    const existing = await prisma.label.findUnique({ where: { id: labelId } });
    if (!existing || existing.teamId !== null) throw Errors.notFound('Predefined label not found');
    // Cascades to TaskLabel / ProjectLabel across every team that used it.
    await prisma.label.delete({ where: { id: labelId } });
  }
}

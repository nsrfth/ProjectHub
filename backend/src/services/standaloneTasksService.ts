import type { GlobalRole, Prisma, StandaloneTask, StandaloneTaskStatus } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { AppError } from '../lib/errors.js';
import { resolveProjectAccess } from '../lib/projectAccess.js';
import { TasksService } from './tasksService.js';
import type {
  CreateStandaloneTaskBody,
  ListStandaloneTasksQuery,
  PromoteStandaloneTaskBody,
  ReorderStandaloneTasksBody,
  UpdateStandaloneTaskBody,
} from '../schemas/standaloneTasks.js';

// v2.5.28 (StandaloneTask, Option C): personal-task business logic. EVERY query
// is filtered by `ownerId` — a row belonging to another user is invisible
// (404, never 403 — do not leak existence). No teamId, no project machinery.

function notFound(): AppError {
  return new AppError(404, 'STANDALONE_TASK_NOT_FOUND', 'Personal task not found');
}

function utcMidnightToday(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

type View = {
  id: string;
  ownerId: string;
  title: string;
  description: string | null;
  status: StandaloneTaskStatus;
  priority: StandaloneTask['priority'];
  dueDate: string | null;
  completedAt: string | null;
  sortOrder: number;
  promotedTaskId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

function toView(row: StandaloneTask): View {
  return {
    id: row.id,
    ownerId: row.ownerId,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    dueDate: row.dueDate?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    sortOrder: row.sortOrder,
    promotedTaskId: row.promotedTaskId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}

export class StandaloneTasksService {
  private tasks = new TasksService();

  async list(ownerId: string, q: ListStandaloneTasksQuery): Promise<View[]> {
    const where: Prisma.StandaloneTaskWhereInput = { ownerId };

    if (q.scope === 'active') where.deletedAt = null;
    else if (q.scope === 'deleted') where.deletedAt = { not: null };
    // 'all' → no deletedAt filter.

    if (q.status) where.status = q.status;

    if (q.q) {
      where.OR = [
        { title: { contains: q.q, mode: 'insensitive' } },
        { description: { contains: q.q, mode: 'insensitive' } },
      ];
    }

    if (q.due && q.due !== 'all') {
      const today = utcMidnightToday();
      if (q.due === 'overdue') {
        where.dueDate = { lt: today };
        where.status = { not: 'DONE' };
      } else if (q.due === 'today') {
        const tomorrow = new Date(today.getTime() + 86_400_000);
        where.dueDate = { gte: today, lt: tomorrow };
      } else if (q.due === 'week') {
        const weekEnd = new Date(today.getTime() + 7 * 86_400_000);
        where.dueDate = { gte: today, lt: weekEnd };
      }
    }

    const rows = await prisma.standaloneTask.findMany({
      where,
      orderBy: [{ status: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map(toView);
  }

  private async getOwned(ownerId: string, id: string): Promise<StandaloneTask> {
    const row = await prisma.standaloneTask.findFirst({ where: { id, ownerId } });
    if (!row) throw notFound();
    return row;
  }

  async create(ownerId: string, body: CreateStandaloneTaskBody): Promise<View> {
    // New tasks land at the end of the TODO column.
    const last = await prisma.standaloneTask.findFirst({
      where: { ownerId, status: 'TODO', deletedAt: null },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });
    const row = await prisma.standaloneTask.create({
      data: {
        ownerId,
        title: body.title,
        description: body.description ?? null,
        priority: body.priority ?? null,
        dueDate: body.dueDate ? new Date(body.dueDate) : null,
        sortOrder: (last?.sortOrder ?? -1) + 1,
      },
    });
    return toView(row);
  }

  async update(ownerId: string, id: string, body: UpdateStandaloneTaskBody): Promise<View> {
    const current = await this.getOwned(ownerId, id);
    const data: Prisma.StandaloneTaskUpdateInput = {};

    if (body.title !== undefined) data.title = body.title;
    if (body.description !== undefined) data.description = body.description;
    if (body.priority !== undefined) data.priority = body.priority;

    if (body.dueDate !== undefined) {
      const next = body.dueDate ? new Date(body.dueDate) : null;
      data.dueDate = next;
      // Reset the one-shot reminder marker when the due date actually moves
      // (mirrors Task.dueNotifiedAt reset behaviour).
      const changed = (current.dueDate?.getTime() ?? null) !== (next?.getTime() ?? null);
      if (changed) data.lastDueNotifiedAt = null;
    }

    if (body.status !== undefined && body.status !== current.status) {
      data.status = body.status;
      // Set/clear completedAt on DONE transitions.
      if (body.status === 'DONE') data.completedAt = new Date();
      else if (current.status === 'DONE') data.completedAt = null;
      // Append to the end of the destination column.
      const last = await prisma.standaloneTask.findFirst({
        where: { ownerId, status: body.status, deletedAt: null },
        orderBy: { sortOrder: 'desc' },
        select: { sortOrder: true },
      });
      data.sortOrder = (last?.sortOrder ?? -1) + 1;
    }

    const row = await prisma.standaloneTask.update({ where: { id }, data });
    return toView(row);
  }

  async remove(ownerId: string, id: string): Promise<void> {
    await this.getOwned(ownerId, id);
    await prisma.standaloneTask.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  async restore(ownerId: string, id: string): Promise<View> {
    await this.getOwned(ownerId, id);
    const row = await prisma.standaloneTask.update({ where: { id }, data: { deletedAt: null } });
    return toView(row);
  }

  // Dense sortOrder reshuffle within a single status column. Only ids the caller
  // owns (in that status, not deleted) are repositioned; unknown ids are ignored.
  async reorder(ownerId: string, body: ReorderStandaloneTasksBody): Promise<View[]> {
    const owned = await prisma.standaloneTask.findMany({
      where: { ownerId, status: body.status, deletedAt: null },
      select: { id: true },
    });
    const ownedIds = new Set(owned.map((r) => r.id));
    const ordered = body.orderedIds.filter((id) => ownedIds.has(id));

    await prisma.$transaction(
      ordered.map((id, index) =>
        prisma.standaloneTask.update({ where: { id }, data: { sortOrder: index } }),
      ),
    );
    return this.list(ownerId, { status: body.status, due: 'all', scope: 'active' });
  }

  // v2.5.28 (D8): one-way promote to a real project Task via the existing task
  // service (its authorization applies). PLAIN promotedTaskId, no FK. On partial
  // failure (task created but standalone finalize failed) return PROMOTE_PARTIAL
  // rather than attempting a cross-service rollback.
  async promote(
    ownerId: string,
    globalRole: GlobalRole,
    id: string,
    body: PromoteStandaloneTaskBody,
  ): Promise<{
    task: { id: string; projectId: string; teamId: string };
    standaloneTaskId: string;
    warning: string | null;
  }> {
    const st = await this.getOwned(ownerId, id);
    if (st.deletedAt) throw new AppError(400, 'STANDALONE_TASK_DELETED', 'Cannot promote a deleted task');
    if (st.promotedTaskId) {
      throw new AppError(409, 'STANDALONE_TASK_ALREADY_PROMOTED', 'This task was already promoted');
    }

    const project = await prisma.project.findUnique({
      where: { id: body.projectId },
      select: { teamId: true },
    });
    // Existence-hiding: unknown/cross-team project → 404, not 403.
    if (!project) throw new AppError(404, 'NOT_FOUND', 'Project not found');
    const access = await resolveProjectAccess(body.projectId, project.teamId, ownerId, globalRole);
    if (access === 'NONE') throw new AppError(404, 'NOT_FOUND', 'Project not found');
    if (access !== 'WRITE') {
      throw new AppError(403, 'FORBIDDEN', 'You need write access to that project');
    }

    const created = await this.tasks.create(project.teamId, body.projectId, ownerId, globalRole, {
      title: st.title,
      description: st.description ?? undefined,
      priority: st.priority ?? undefined,
      dueDate: st.dueDate ? st.dueDate.toISOString() : undefined,
    });
    const taskId = (created as { id: string }).id;

    try {
      await prisma.standaloneTask.update({
        where: { id },
        data: { deletedAt: new Date(), promotedTaskId: taskId },
      });
    } catch {
      return {
        task: { id: taskId, projectId: body.projectId, teamId: project.teamId },
        standaloneTaskId: id,
        warning: 'PROMOTE_PARTIAL',
      };
    }

    return {
      task: { id: taskId, projectId: body.projectId, teamId: project.teamId },
      standaloneTaskId: id,
      warning: null,
    };
  }
}

import type { Prisma, SubtaskStatus, TaskPriority, TaskStatus } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';
import type { MeTasksQuery } from '../schemas/meTasks.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const OPEN_STATUSES: TaskStatus[] = ['TODO', 'IN_PROGRESS', 'REVIEW', 'PENDING_APPROVAL'];

const TASK_INCLUDE = {
  project: {
    select: {
      id: true,
      name: true,
      team: { select: { id: true, name: true } },
    },
  },
  assignee: { select: { id: true, name: true } },
  responsible: { select: { name: true } },
  labels: { include: { label: true } },
  subtasks: {
    orderBy: { position: 'asc' as const },
    include: {
      responsible: { select: { name: true } },
      assignee: { select: { name: true } },
    },
  },
} as const;

type TaskRow = Prisma.TaskGetPayload<{ include: typeof TASK_INCLUDE }>;

export interface MeTaskRow {
  id: string;
  projectId: string;
  projectName: string;
  teamId: string;
  teamName: string;
  creatorId: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  responsibleId: string | null;
  responsibleName: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  startDate: string | null;
  dueDate: string | null;
  plannedDate: string | null;
  completedAt: string | null;
  plannedBudget: string | null;
  actualSpent: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
  labels: { id: string; name: string; color: string }[];
  subtasks: {
    id: string;
    taskId: string;
    title: string;
    done: boolean;
    status: SubtaskStatus;
    responsibleId: string | null;
    responsibleName: string | null;
    assigneeId: string | null;
    assigneeName: string | null;
    startDate: string | null;
    endDate: string | null;
    position: number;
  }[];
  incompleteBlockerCount: number;
}

function serializeRow(row: TaskRow, blockerCount = 0): MeTaskRow {
  return {
    id: row.id,
    projectId: row.projectId,
    projectName: row.project.name,
    teamId: row.teamId,
    teamName: row.project.team.name,
    creatorId: row.creatorId,
    assigneeId: row.assigneeId,
    assigneeName: row.assignee?.name ?? null,
    responsibleId: row.responsibleId,
    responsibleName: row.responsible?.name ?? null,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    startDate: row.startDate?.toISOString() ?? null,
    dueDate: row.dueDate?.toISOString() ?? null,
    plannedDate: row.plannedDate?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    plannedBudget: row.plannedBudget === null ? null : row.plannedBudget.toFixed(2),
    actualSpent: row.actualSpent === null ? null : row.actualSpent.toFixed(2),
    position: row.position,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    labels: row.labels.map((tl) => ({
      id: tl.label.id,
      name: tl.label.name,
      color: tl.label.color,
    })),
    subtasks: row.subtasks.map((s) => ({
      id: s.id,
      taskId: s.taskId,
      title: s.title,
      done: s.done,
      status: s.status,
      responsibleId: s.responsibleId,
      responsibleName: s.responsible?.name ?? null,
      assigneeId: s.assigneeId,
      assigneeName: s.assignee?.name ?? null,
      startDate: s.startDate?.toISOString() ?? null,
      endDate: s.endDate?.toISOString() ?? null,
      position: s.position,
    })),
    incompleteBlockerCount: blockerCount,
  };
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function endOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
}

export class MeTasksService {
  // Cross-project inbox for the caller. Scoped to teams they belong to and
  // tasks where assigneeId = userId. Mirrors calendar/reports team scoping —
  // project ownership is NOT required to see an assigned task here.
  async listForUser(
    userId: string,
    query: MeTasksQuery,
  ): Promise<{ items: MeTaskRow[]; nextCursor: string | null; total: number }> {
    const memberships = await prisma.teamMembership.findMany({
      where: { userId },
      select: { teamId: true },
    });
    const teamIds = memberships.map((m: { teamId: string }) => m.teamId);
    if (query.teamId && !teamIds.includes(query.teamId)) {
      throw Errors.forbidden('Not a member of this team');
    }
    if (teamIds.length === 0) {
      return { items: [], nextCursor: null, total: 0 };
    }

    const now = new Date();
    const todayStart = startOfUtcDay(now);
    const todayEnd = endOfUtcDay(now);
    const weekEnd = new Date(todayStart.getTime() + 7 * MS_PER_DAY);

    const where: Prisma.TaskWhereInput = {
      deletedAt: null,
      assigneeId: userId,
      teamId: query.teamId ? query.teamId : { in: teamIds },
      ...(query.projectId && { projectId: query.projectId }),
      ...(query.status && { status: query.status }),
      ...(query.priority && { priority: query.priority }),
      ...(query.q && {
        title: { contains: query.q, mode: 'insensitive' },
      }),
    };

    if (query.filter === 'completed') {
      where.status = 'DONE';
    } else if (query.filter === 'high_priority') {
      where.priority = { in: ['HIGH', 'URGENT'] };
      where.status = { in: OPEN_STATUSES };
    } else if (query.filter === 'overdue') {
      where.status = { in: OPEN_STATUSES };
      where.dueDate = { lt: now, not: null };
    } else if (query.filter === 'due_today') {
      where.status = { in: OPEN_STATUSES };
      where.dueDate = { gte: todayStart, lt: todayEnd };
    } else if (query.filter === 'upcoming') {
      where.status = { in: OPEN_STATUSES };
      where.dueDate = { gte: todayEnd, lte: weekEnd };
    }

    const sortField = query.sort ?? 'dueDate';
    const sortOrder = query.order ?? 'asc';
    const limit = query.limit ?? 50;

    const orderBy: Prisma.TaskOrderByWithRelationInput[] = [];
    if (sortField === 'dueDate') {
      orderBy.push({ dueDate: { sort: sortOrder, nulls: 'last' } });
    } else if (sortField === 'priority') {
      orderBy.push({ priority: sortOrder });
    } else if (sortField === 'status') {
      orderBy.push({ status: sortOrder });
    } else {
      orderBy.push({ createdAt: sortOrder });
    }
    orderBy.push({ id: 'asc' });

    const total = await prisma.task.count({ where });

    const offset = query.offset ?? 0;

    const rows = await prisma.task.findMany({
      where,
      include: TASK_INCLUDE,
      orderBy,
      skip: offset,
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? String(offset + limit) : null;

    return {
      items: page.map((r) => serializeRow(r)),
      nextCursor,
      total,
    };
  }
}

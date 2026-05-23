import { Prisma, type TaskPriority, type TaskStatus } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';
import { logActivity } from './activityLogger.js';
import { notifications } from './notificationsService.js';
import { WebhookService } from './webhookService.js';

// Webhook emitter shared across task-mutating paths. emit() is best-effort
// and runs after the transaction commits — failures don't bubble.
const _webhooks = new WebhookService();

// Tasks live inside a project, which lives inside a team. teamId is denormalized
// on Task itself (see schema) so multi-tenancy queries are a single-column
// filter and the kanban view doesn't need a join.
//
// The route layer enforces team membership; this service additionally enforces
// that the (teamId, projectId) and (projectId, taskId) parent chains are
// consistent. Mismatches return 404, never 200 — never leak resource existence
// across tenants.

const POSITION_GAP = 1000;

export interface TaskLabelView {
  id: string;
  name: string;
  color: string;
}

export interface TaskSubtaskView {
  id: string;
  taskId: string;
  title: string;
  done: boolean;
  position: number;
}

export interface TaskView {
  id: string;
  projectId: string;
  teamId: string;
  // Nullable since admin can delete a user; we SetNull rather than cascade
  // to preserve the task's history. Frontend renders as "(deleted user)".
  creatorId: string | null;
  assigneeId: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: Date | null;
  plannedDate: Date | null;
  completedAt: Date | null;
  position: number;
  createdAt: Date;
  updatedAt: Date;
  labels: TaskLabelView[];
  subtasks: TaskSubtaskView[];
}

// Prisma `include` shape reused across list/get/update so the labels[] and
// subtasks[] fields are always populated on TaskView. A separate type alias
// keeps the includes hardcoded in one place.
const TASK_INCLUDE = {
  labels: { include: { label: true } },
  subtasks: { orderBy: { position: 'asc' } },
} as const;

function toView(row: Prisma.TaskGetPayload<{ include: typeof TASK_INCLUDE }>): TaskView {
  return {
    id: row.id,
    projectId: row.projectId,
    teamId: row.teamId,
    creatorId: row.creatorId,
    assigneeId: row.assigneeId,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    dueDate: row.dueDate,
    plannedDate: row.plannedDate,
    completedAt: row.completedAt,
    position: row.position,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    labels: row.labels.map((tl) => ({ id: tl.label.id, name: tl.label.name, color: tl.label.color })),
    subtasks: row.subtasks.map((s) => ({
      id: s.id,
      taskId: s.taskId,
      title: s.title,
      done: s.done,
      position: s.position,
    })),
  };
}

export class TasksService {
  // Verifies the project belongs to the team. Returns the project (callers
  // sometimes need fields from it) or throws 404 to hide cross-tenant probes.
  private async ensureProjectInTeam(teamId: string, projectId: string) {
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project || project.teamId !== teamId) throw Errors.notFound('Project not found');
    return project;
  }

  async create(
    teamId: string,
    projectId: string,
    creatorId: string,
    input: {
      title: string;
      description?: string;
      status?: TaskStatus;
      priority?: TaskPriority;
      assigneeId?: string | null;
      dueDate?: string | null;
      plannedDate?: string | null;
      completedAt?: string | null;
    },
  ): Promise<TaskView> {
    await this.ensureProjectInTeam(teamId, projectId);

    if (input.assigneeId) {
      // Only allow assigning to a team member — otherwise the task would be
      // assigned to someone who can't see it.
      const membership = await prisma.teamMembership.findUnique({
        where: { userId_teamId: { userId: input.assigneeId, teamId } },
      });
      if (!membership) throw Errors.badRequest('Assignee is not a member of this team');
    }

    const status = input.status ?? 'TODO';

    // Append to the end of the target status column. Sparse positions (gap of
    // 1000) leave room for client-driven inserts later without a full re-number.
    const last = await prisma.task.findFirst({
      where: { projectId, status },
      orderBy: { position: 'desc' },
      select: { position: true },
    });
    const position = (last?.position ?? 0) + POSITION_GAP;

    // completedAt resolution at create time:
    //   - explicit input wins (member backdates)
    //   - else, if creating directly into status=DONE, stamp now
    //   - else, null
    const completedAt =
      input.completedAt !== undefined
        ? input.completedAt === null
          ? null
          : new Date(input.completedAt)
        : status === 'DONE'
          ? new Date()
          : null;

    return prisma.$transaction(async (tx) => {
      const task = await tx.task.create({
        data: {
          teamId,
          projectId,
          creatorId,
          assigneeId: input.assigneeId ?? null,
          title: input.title,
          description: input.description ?? null,
          status,
          priority: input.priority ?? 'MEDIUM',
          dueDate: input.dueDate ? new Date(input.dueDate) : null,
          plannedDate: input.plannedDate ? new Date(input.plannedDate) : null,
          completedAt,
          position,
        },
        include: TASK_INCLUDE,
      });
      await logActivity(tx, {
        taskId: task.id,
        actorId: creatorId,
        action: 'task.created',
        meta: { title: task.title, status: task.status, priority: task.priority },
      });
      // Initial assignment is a real assignment event from the assignee's POV.
      if (task.assigneeId) {
        await notifications.onTaskAssigned(tx, {
          taskId: task.id,
          projectId: task.projectId,
          teamId: task.teamId,
          actorId: creatorId,
          newAssigneeId: task.assigneeId,
          taskTitle: task.title,
        });
      }
      return toView(task);
    }).then(async (view) => {
      // Webhook emit after commit — never inside the transaction (the
      // dispatcher reads from the same table and we don't want to hold
      // the connection while we look up subscribers). Awaited so callers
      // (including the dispatcher right after a synchronous test action)
      // can rely on the delivery row existing on return.
      await _webhooks.emit(view.teamId, 'task.created', view);
      return view;
    });
  }

  async list(
    teamId: string,
    projectId: string,
    filter: { status?: TaskStatus },
  ): Promise<TaskView[]> {
    await this.ensureProjectInTeam(teamId, projectId);
    const rows = await prisma.task.findMany({
      where: { teamId, projectId, ...(filter.status && { status: filter.status }) },
      // Same ordering as the kanban view — by column (status), then position.
      orderBy: [{ status: 'asc' }, { position: 'asc' }],
      include: TASK_INCLUDE,
    });
    return rows.map(toView);
  }

  async get(teamId: string, projectId: string, taskId: string): Promise<TaskView> {
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      include: TASK_INCLUDE,
    });
    if (!task || task.teamId !== teamId || task.projectId !== projectId) {
      throw Errors.notFound('Task not found');
    }
    return toView(task);
  }

  async update(
    teamId: string,
    projectId: string,
    taskId: string,
    actorId: string,
    input: {
      title?: string;
      description?: string | null;
      status?: TaskStatus;
      priority?: TaskPriority;
      assigneeId?: string | null;
      dueDate?: string | null;
      plannedDate?: string | null;
      completedAt?: string | null;
    },
  ): Promise<TaskView> {
    const existing = await this.get(teamId, projectId, taskId);

    if (input.assigneeId) {
      const membership = await prisma.teamMembership.findUnique({
        where: { userId_teamId: { userId: input.assigneeId, teamId } },
      });
      if (!membership) throw Errors.badRequest('Assignee is not a member of this team');
    }

    // Moving across status columns: re-append to the end of the new column so
    // the task lands somewhere sensible. Reordering within a column is a
    // future endpoint (drag-and-drop UI).
    let nextPosition = existing.position;
    const statusChanged = input.status !== undefined && input.status !== existing.status;
    if (statusChanged) {
      const last = await prisma.task.findFirst({
        where: { projectId, status: input.status },
        orderBy: { position: 'desc' },
        select: { position: true },
      });
      nextPosition = (last?.position ?? 0) + POSITION_GAP;
    }

    // completedAt resolution on update:
    //   - explicit input wins (allows manual set, clear, or backdate)
    //   - else, if transitioning to DONE and completedAt was null, auto-fill now
    //   - else, leave as-is
    let resolvedCompletedAt: Date | null | undefined;
    if (input.completedAt !== undefined) {
      resolvedCompletedAt = input.completedAt === null ? null : new Date(input.completedAt);
    } else if (statusChanged && input.status === 'DONE' && existing.completedAt === null) {
      resolvedCompletedAt = new Date();
    } else {
      resolvedCompletedAt = undefined; // skip update
    }

    // Build the list of non-status fields the user explicitly changed so the
    // audit entry stays compact (no-op PATCHes emit nothing). For completedAt
    // we look at input.completedAt (explicit edit), NOT the auto-filled
    // resolvedCompletedAt — auto-fill on TODO→DONE is a side-effect of the
    // status_changed event, not a separate "the user edited completedAt" event.
    const NON_STATUS_FIELDS = [
      'title',
      'description',
      'priority',
      'assigneeId',
      'dueDate',
      'plannedDate',
      'completedAt',
    ] as const;
    const DATE_FIELDS = new Set(['dueDate', 'plannedDate', 'completedAt']);
    const changedNonStatusFields = NON_STATUS_FIELDS.filter((f) => {
      const incoming = (input as Record<string, unknown>)[f];
      if (incoming === undefined) return false;
      const current = (existing as unknown as Record<string, unknown>)[f];
      if (DATE_FIELDS.has(f)) {
        const a = current instanceof Date ? current.toISOString() : null;
        const b =
          typeof incoming === 'string' ? new Date(incoming).toISOString() : incoming === null ? null : null;
        return a !== b;
      }
      return current !== incoming;
    });

    try {
      const result = await prisma.$transaction(async (tx) => {
        const updated = await tx.task.update({
          where: { id: taskId },
          data: {
            ...(input.title !== undefined && { title: input.title }),
            ...(input.description !== undefined && { description: input.description }),
            ...(input.status !== undefined && { status: input.status, position: nextPosition }),
            ...(input.priority !== undefined && { priority: input.priority }),
            ...(input.assigneeId !== undefined && { assigneeId: input.assigneeId }),
            ...(input.dueDate !== undefined && {
              dueDate: input.dueDate === null ? null : new Date(input.dueDate),
              // Reset the TASK_DUE notification flag whenever dueDate changes
              // so the scheduler treats the new date as fresh and notifies again.
              dueNotifiedAt: null,
            }),
            ...(input.plannedDate !== undefined && {
              plannedDate: input.plannedDate === null ? null : new Date(input.plannedDate),
            }),
            ...(resolvedCompletedAt !== undefined && { completedAt: resolvedCompletedAt }),
          },
          include: TASK_INCLUDE,
        });

        // Emit one status-change row and (separately) one updated-fields row
        // so the timeline reads naturally. A no-op PATCH (everything matched)
        // emits nothing — don't spam the audit log.
        if (statusChanged) {
          await logActivity(tx, {
            taskId,
            actorId,
            action: 'task.status_changed',
            meta: { from: existing.status, to: input.status },
          });
          await notifications.onStatusChanged(tx, {
            taskId,
            projectId: existing.projectId,
            teamId: existing.teamId,
            actorId,
            from: existing.status,
            to: input.status!,
            taskTitle: updated.title,
          });
        }
        if (changedNonStatusFields.length > 0) {
          await logActivity(tx, {
            taskId,
            actorId,
            action: 'task.updated',
            meta: { fields: changedNonStatusFields },
          });
        }
        // Assignment change is its own notification — only fires when the
        // new assignee is set (clearing assignment doesn't notify anyone).
        if (
          changedNonStatusFields.includes('assigneeId') &&
          updated.assigneeId &&
          updated.assigneeId !== existing.assigneeId
        ) {
          await notifications.onTaskAssigned(tx, {
            taskId,
            projectId: existing.projectId,
            teamId: existing.teamId,
            actorId,
            newAssigneeId: updated.assigneeId,
            taskTitle: updated.title,
          });
        }
        return { view: toView(updated), statusChanged, changedNonStatusFields, fromStatus: existing.status };
      });
      // Post-commit webhook fan-out. status_changed is emitted as a separate
      // event from updated so subscribers can subscribe to only the signal
      // they care about. Awaited so the delivery row exists by the time
      // the response returns to the client (and by the time tests inspect).
      if (result.statusChanged) {
        await _webhooks.emit(result.view.teamId, 'task.status_changed', {
          task: result.view, from: result.fromStatus, to: result.view.status,
        });
      }
      if (result.changedNonStatusFields.length > 0) {
        await _webhooks.emit(result.view.teamId, 'task.updated', {
          task: result.view, fields: result.changedNonStatusFields,
        });
      }
      return result.view;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        throw Errors.notFound('Task not found');
      }
      throw err;
    }
  }

  // Place `taskId` immediately before `beforeTaskId` in the target column.
  // beforeTaskId === null → drop at the end of the column.
  //
  // Position math:
  //   - between two existing tasks: midpoint of their positions
  //   - at the head (before first task): firstPos - POSITION_GAP
  //   - at the tail: lastPos + POSITION_GAP (or POSITION_GAP if empty)
  //
  // When the gap collapses to <= 1 (very long lifetimes of insert-between),
  // re-number the whole column with fresh sparse positions. Cheap enough at
  // kanban scale and avoids the floating-point complexity of fractional indexing.
  async reorder(
    teamId: string,
    projectId: string,
    taskId: string,
    actorId: string,
    input: { status: TaskStatus; beforeTaskId: string | null },
  ): Promise<TaskView> {
    const existing = await this.get(teamId, projectId, taskId);
    if (input.beforeTaskId === taskId) {
      throw Errors.badRequest('Cannot reorder a task before itself');
    }

    return prisma.$transaction(async (tx) => {
      let newPosition: number;
      if (input.beforeTaskId === null) {
        const last = await tx.task.findFirst({
          where: { projectId, status: input.status, NOT: { id: taskId } },
          orderBy: { position: 'desc' },
          select: { position: true },
        });
        newPosition = (last?.position ?? 0) + POSITION_GAP;
      } else {
        const before = await tx.task.findUnique({
          where: { id: input.beforeTaskId },
          select: { id: true, projectId: true, status: true, position: true },
        });
        if (!before || before.projectId !== projectId || before.status !== input.status) {
          throw Errors.badRequest('beforeTaskId is not in the target column');
        }
        const prev = await tx.task.findFirst({
          where: {
            projectId,
            status: input.status,
            position: { lt: before.position },
            NOT: { id: taskId },
          },
          orderBy: { position: 'desc' },
          select: { position: true },
        });
        if (prev) {
          newPosition = Math.floor((prev.position + before.position) / 2);
          if (newPosition <= prev.position || newPosition >= before.position) {
            newPosition = await this.renumberColumn(tx, projectId, input.status, taskId, input.beforeTaskId);
          }
        } else {
          newPosition = before.position - POSITION_GAP;
        }
      }

      const statusChanged = input.status !== existing.status;
      const updated = await tx.task.update({
        where: { id: taskId },
        data: { status: input.status, position: newPosition },
        include: TASK_INCLUDE,
      });
      if (statusChanged) {
        await logActivity(tx, {
          taskId,
          actorId,
          action: 'task.status_changed',
          meta: { from: existing.status, to: input.status },
        });
        await notifications.onStatusChanged(tx, {
          taskId,
          projectId: existing.projectId,
          teamId: existing.teamId,
          actorId,
          from: existing.status,
          to: input.status,
          taskTitle: updated.title,
        });
      }
      return toView(updated);
    });
  }

  // Rewrite every task in (projectId, status) with sparse positions. Used as
  // a fallback when adjacent positions are too close to slot a new value between.
  private async renumberColumn(
    tx: Prisma.TransactionClient,
    projectId: string,
    status: TaskStatus,
    movingTaskId: string,
    beforeTaskId: string,
  ): Promise<number> {
    const rows = await tx.task.findMany({
      where: { projectId, status, NOT: { id: movingTaskId } },
      orderBy: { position: 'asc' },
      select: { id: true },
    });
    const order: string[] = [];
    let inserted = false;
    for (const r of rows) {
      if (r.id === beforeTaskId) {
        order.push(movingTaskId);
        inserted = true;
      }
      order.push(r.id);
    }
    if (!inserted) order.push(movingTaskId);

    let myPos = POSITION_GAP;
    for (let i = 0; i < order.length; i++) {
      const pos = (i + 1) * POSITION_GAP;
      const id = order[i]!;
      await tx.task.update({ where: { id }, data: { position: pos } });
      if (id === movingTaskId) myPos = pos;
    }
    return myPos;
  }

  async remove(teamId: string, projectId: string, taskId: string, _actorId: string): Promise<void> {
    const existing = await this.get(teamId, projectId, taskId); // 404 if not in this project/team
    // No activity row on delete: Activity FK cascades from Task, so any row we
    // wrote would vanish with the task. A real audit trail belongs in a
    // separate non-cascading table; that's a deliberate later step.
    await prisma.task.delete({ where: { id: taskId } });
    // Webhook subscribers DO want to know — the delete event fires from the
    // service layer because it's the only place we have the team scope after
    // the row is gone. Awaited so the delivery row exists synchronously.
    await _webhooks.emit(teamId, 'task.deleted', {
      taskId: existing.id, title: existing.title, projectId, teamId,
    });
  }
}

import { Prisma, type Currency, type GlobalRole, type TaskPriority, type TaskStatus, type TeamRole } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';
import { assertCanWriteProject } from '../lib/projectAccess.js';
import { logActivity } from './activityLogger.js';
import { notifications } from './notificationsService.js';
import { WebhookService } from './webhookService.js';
import { DependenciesService } from './dependenciesService.js';
import { userHasPermission } from '../middleware/requirePermission.js';
import {
  CustomFieldsService,
  type TaskCustomFieldValueView,
} from './customFieldsService.js';
import {
  logDueDateRoll,
  resolveDueDateForScheduling,
} from '../lib/schedulingSettings.js';

// v1.18: read the instance-level date-edit restriction at PATCH time. Members
// can always ADD a date that's null; only MANAGERS / global ADMINs can MODIFY
// or CLEAR a non-null date when the setting is "manager-only".
async function readDateEditRestriction(): Promise<'open' | 'manager-only'> {
  try {
    const row = await prisma.instanceSetting.findUnique({
      where: { key: 'tasks.dateEditRestriction' },
    });
    return row?.value === 'manager-only' ? 'manager-only' : 'open';
  } catch {
    return 'open';
  }
}

// Throws 403 with a friendly message if the caller is gated out of modifying
// the supplied date field. Pure helper — no DB calls.
function assertCanEditDate(
  fieldLabel: string,
  existingValue: Date | null,
  incomingValue: string | null,
  callerTeamRole: TeamRole,
  callerGlobalRole: GlobalRole,
  restriction: 'open' | 'manager-only',
): void {
  if (restriction !== 'manager-only') return;
  if (callerTeamRole === 'MANAGER' || callerGlobalRole === 'ADMIN') return;
  // Adding a date when none exists is always allowed (the wording from the
  // user request: "they can add but they can't modify"). Modification +
  // clearing both require manager/admin.
  const incomingDate = incomingValue === null ? null : new Date(incomingValue);
  const existingIso = existingValue?.toISOString() ?? null;
  const incomingIso = incomingDate?.toISOString() ?? null;
  if (existingIso === incomingIso) return; // no-op
  if (existingValue === null) return; // adding
  throw Errors.forbidden(
    `${fieldLabel} can only be changed by team managers or admins on this instance`,
  );
}

// Webhook emitter shared across task-mutating paths. emit() is best-effort
// and runs after the transaction commits — failures don't bubble.
const _webhooks = new WebhookService();

// v1.29: dependency-graph reader used to hydrate blocker counts onto every
// TaskView + run the status guard before status transitions. Held module-
// level so the same instance is reused across calls.
const _deps = new DependenciesService();
const _customFields = new CustomFieldsService();

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
  // v1.19: Subtask technician — same semantics as Task.technicianId.
  technicianId: string | null;
  technicianName: string | null;
  // v1.42: Subtask assignee — lighter "who's doing this now" field.
  assigneeId: string | null;
  assigneeName: string | null;
  // v1.41: optional scheduling window.
  startDate: string | null;
  endDate: string | null;
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
  // v1.19: "Assigned Technician" — the person actually doing the work.
  // Defaults to creator at create-time; only team MANAGERS / global ADMINs
  // can change it after. technicianName is joined for the UI.
  technicianId: string | null;
  technicianName: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  // v1.37: started-on date. Null when not yet marked. No scheduler or
  // report consumes it today — informational on the UI only.
  startDate: Date | null;
  dueDate: Date | null;
  plannedDate: Date | null;
  completedAt: Date | null;
  // v1.42: optional task budget fields. Fixed-2 strings on the wire
  // (Decimal serializes to string to preserve precision); null when unset.
  plannedBudget: string | null;
  actualSpent: string | null;
  budgetCurrency: Currency;
  position: number;
  createdAt: Date;
  updatedAt: Date;
  labels: TaskLabelView[];
  subtasks: TaskSubtaskView[];
  // v1.29: number of FINISH_TO_START dependencies of this task whose
  // blocker is not DONE (and not soft-deleted). 0 when no blockers exist,
  // when every blocker is complete, or when toView was called before the
  // blocker map was hydrated (only on internal helper paths).
  incompleteBlockerCount: number;
  customFields: TaskCustomFieldValueView[];
}

// Prisma `include` shape reused across list/get/update so the labels[] and
// subtasks[] fields are always populated on TaskView. A separate type alias
// keeps the includes hardcoded in one place.
const TASK_INCLUDE = {
  project: { select: { budgetCurrency: true } },
  labels: { include: { label: true } },
  // v1.19: pull subtask technician name in the same query so the UI doesn't
  // need to look up users separately. Same for the task itself below.
  // v1.42: also pull subtask assignee name.
  subtasks: {
    orderBy: { position: 'asc' },
    include: {
      technician: { select: { name: true } },
      assignee: { select: { name: true } },
    },
  },
  technician: { select: { name: true } },
} as const;

function toView(
  row: Prisma.TaskGetPayload<{ include: typeof TASK_INCLUDE }>,
  // v1.29: optional blocker count — callers that don't pre-fetch the map
  // pass undefined and default to 0. The list / get / update / create
  // paths all hydrate this; subtask + label-tweak paths that touch a
  // task without changing its dependency graph can rely on the default.
  incompleteBlockerCount = 0,
  customFields: TaskCustomFieldValueView[] = [],
): TaskView {
  return {
    id: row.id,
    projectId: row.projectId,
    teamId: row.teamId,
    creatorId: row.creatorId,
    assigneeId: row.assigneeId,
    technicianId: row.technicianId,
    technicianName: row.technician?.name ?? null,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    startDate: row.startDate,
    dueDate: row.dueDate,
    plannedDate: row.plannedDate,
    completedAt: row.completedAt,
    // v1.42: Decimal → fixed-2 string. Mirrors v1.41 Project.toView.
    plannedBudget: row.plannedBudget === null ? null : row.plannedBudget.toFixed(2),
    actualSpent: row.actualSpent === null ? null : row.actualSpent.toFixed(2),
    budgetCurrency: row.project.budgetCurrency,
    position: row.position,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    labels: row.labels.map((tl) => ({ id: tl.label.id, name: tl.label.name, color: tl.label.color })),
    subtasks: row.subtasks.map((s) => ({
      id: s.id,
      taskId: s.taskId,
      title: s.title,
      done: s.done,
      technicianId: s.technicianId,
      technicianName: s.technician?.name ?? null,
      // v1.42: subtask assignee joined for the UI.
      assigneeId: s.assigneeId,
      assigneeName: s.assignee?.name ?? null,
      // v1.41: subtask scheduling window — ISO strings on the wire.
      startDate: s.startDate ? s.startDate.toISOString() : null,
      endDate: s.endDate ? s.endDate.toISOString() : null,
      position: s.position,
    })),
    incompleteBlockerCount,
    customFields,
  };
}

// v1.42: shared budget normaliser. number | string | null → Prisma.Decimal | null.
function normaliseBudget(v: number | string | null | undefined): Prisma.Decimal | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const s = typeof v === 'number' ? String(v) : v.trim();
  if (s.length === 0) return null;
  return new Prisma.Decimal(s);
}

async function attachCustomFields(teamId: string, views: TaskView[]): Promise<TaskView[]> {
  if (views.length === 0) return views;
  const map = await _customFields.buildCustomFieldsForTasks(
    teamId,
    views.map((v) => v.id),
  );
  return views.map((v) => ({ ...v, customFields: map.get(v.id) ?? [] }));
}

async function withCustomFields(teamId: string, view: TaskView): Promise<TaskView> {
  const results = await attachCustomFields(teamId, [view]);
  return results[0] ?? view;
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
    creatorGlobalRole: GlobalRole,
    input: {
      title: string;
      description?: string;
      status?: TaskStatus;
      priority?: TaskPriority;
      assigneeId?: string | null;
      // v1.37: started-on date. Same shape as the other date fields.
      // Auto-set isn't worth the surprise — left as user-supplied only.
      startDate?: string | null;
      dueDate?: string | null;
      plannedDate?: string | null;
      completedAt?: string | null;
      // v1.42: optional budget pair. number | string | null.
      plannedBudget?: number | string | null;
      actualSpent?: number | string | null;
    },
  ): Promise<TaskView> {
    await assertCanWriteProject(projectId, teamId, creatorId, creatorGlobalRole);
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

    const dueResolved = input.dueDate
      ? await resolveDueDateForScheduling(input.dueDate)
      : { dueDate: null as Date | null, rolled: null };

    return prisma.$transaction(async (tx) => {
      const task = await tx.task.create({
        data: {
          teamId,
          projectId,
          creatorId,
          assigneeId: input.assigneeId ?? null,
          // v1.19: creator becomes the default technician. Managers/admins
          // can reassign post-create via update(); members are gated out.
          technicianId: creatorId,
          title: input.title,
          description: input.description ?? null,
          status,
          priority: input.priority ?? 'MEDIUM',
          startDate: input.startDate ? new Date(input.startDate) : null,
          dueDate: dueResolved.dueDate,
          plannedDate: input.plannedDate ? new Date(input.plannedDate) : null,
          completedAt,
          position,
          // v1.42: Decimal? — Prisma accepts undefined ("don't write") so
          // the conditional spread keeps the default NULL when caller omits.
          ...(normaliseBudget(input.plannedBudget) !== undefined && {
            plannedBudget: normaliseBudget(input.plannedBudget),
          }),
          ...(normaliseBudget(input.actualSpent) !== undefined && {
            actualSpent: normaliseBudget(input.actualSpent),
          }),
        },
        include: TASK_INCLUDE,
      });
      await logActivity(tx, {
        taskId: task.id,
        actorId: creatorId,
        action: 'task.created',
        meta: { title: task.title, status: task.status, priority: task.priority },
      });
      if (dueResolved.rolled) {
        await logDueDateRoll(tx, {
          taskId: task.id,
          actorId: creatorId,
          teamId,
          rolled: dueResolved.rolled,
        });
      }
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
      const blockerCount = await _deps.countIncompleteBlockers(task.id);
      return toView(task, blockerCount);
    }).then(async (view) => {
      // Webhook emit after commit — never inside the transaction (the
      // dispatcher reads from the same table and we don't want to hold
      // the connection while we look up subscribers). Awaited so callers
      // (including the dispatcher right after a synchronous test action)
      // can rely on the delivery row existing on return.
      await _webhooks.emit(view.teamId, 'task.created', view);
      const hydrated = await withCustomFields(teamId, view);
      const { emitAutomationForTask } = await import('./automationEngine.js');
      await emitAutomationForTask({
        teamId: view.teamId,
        projectId: view.projectId,
        taskId: view.id,
        triggerType: 'task.created',
        task: hydrated,
      });
      return hydrated;
    });
  }

  async list(
    teamId: string,
    projectId: string,
    filter: { status?: TaskStatus },
  ): Promise<TaskView[]> {
    await this.ensureProjectInTeam(teamId, projectId);
    const rows = await prisma.task.findMany({
      // v1.21: hide soft-deleted tasks. Trash queries opt back in via
      // listTrashedTasks() below.
      where: {
        teamId,
        projectId,
        deletedAt: null,
        ...(filter.status && { status: filter.status }),
      },
      // Same ordering as the kanban view — by column (status), then position.
      orderBy: [{ status: 'asc' }, { position: 'asc' }],
      include: TASK_INCLUDE,
    });
    // v1.29: one round-trip yields a {taskId → count} map for the whole
    // page. Missing keys default to 0 in toView.
    const blockerCounts = await _deps.loadIncompleteBlockerCounts(rows.map((r) => r.id));
    const views = rows.map((r) => toView(r, blockerCounts.get(r.id) ?? 0));
    return attachCustomFields(teamId, views);
  }

  async get(teamId: string, projectId: string, taskId: string): Promise<TaskView> {
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      include: TASK_INCLUDE,
    });
    // v1.21: a soft-deleted task is treated as a 404 from the regular get path —
    // it's "gone" as far as the kanban / task detail UI is concerned. The Trash
    // surface uses its own queries that opt in to deleted rows.
    if (
      !task ||
      task.teamId !== teamId ||
      task.projectId !== projectId ||
      task.deletedAt !== null
    ) {
      throw Errors.notFound('Task not found');
    }
    const blockerCount = await _deps.countIncompleteBlockers(task.id);
    return withCustomFields(teamId, toView(task, blockerCount));
  }

  async update(
    teamId: string,
    projectId: string,
    taskId: string,
    actorId: string,
    actorTeamRole: TeamRole,
    actorGlobalRole: GlobalRole,
    input: {
      title?: string;
      description?: string | null;
      status?: TaskStatus;
      priority?: TaskPriority;
      assigneeId?: string | null;
      // v1.19: changing technicianId requires team MANAGER or global ADMIN.
      // Undefined = leave as-is; explicit null = clear (also gated).
      technicianId?: string | null;
      // v1.37: started-on date. Subject to the same v1.18 manager-only
      // gate as the other date fields.
      startDate?: string | null;
      dueDate?: string | null;
      plannedDate?: string | null;
      completedAt?: string | null;
      // v1.42: budget patch — undefined leaves, null clears.
      plannedBudget?: number | string | null;
      actualSpent?: number | string | null;
    },
  ): Promise<TaskView> {
    await assertCanWriteProject(projectId, teamId, actorId, actorGlobalRole);
    const existing = await this.get(teamId, projectId, taskId);

    if (input.assigneeId) {
      const membership = await prisma.teamMembership.findUnique({
        where: { userId_teamId: { userId: input.assigneeId, teamId } },
      });
      if (!membership) throw Errors.badRequest('Assignee is not a member of this team');
    }

    // v1.19 → v1.23: technician change gate. Now gated by the
    // `task.change_technician` permission (default = Manager only). Custom
    // roles can grant it independently of the legacy MANAGER bit.
    if (input.technicianId !== undefined && input.technicianId !== existing.technicianId) {
      if (
        !(await userHasPermission(actorId, teamId, actorGlobalRole, 'task.change_technician'))
      ) {
        throw Errors.forbidden(
          'Missing permission: task.change_technician',
        );
      }
      if (input.technicianId !== null) {
        const membership = await prisma.teamMembership.findUnique({
          where: { userId_teamId: { userId: input.technicianId, teamId } },
        });
        if (!membership) throw Errors.badRequest('Technician is not a member of this team');
      }
    }

    // v1.18: date-edit restriction. Only consulted when the caller is
    // touching one of the date fields; the DB read is cheap but
    // skipping it on no-op patches keeps the hot path quick.
    // v1.37: startDate joins dueDate / plannedDate / completedAt under
    // the same gate — same semantics (commitment change).
    if (
      input.startDate !== undefined ||
      input.dueDate !== undefined ||
      input.plannedDate !== undefined ||
      input.completedAt !== undefined
    ) {
      const restriction = await readDateEditRestriction();
      if (input.startDate !== undefined) {
        assertCanEditDate(
          'startDate',
          existing.startDate,
          input.startDate,
          actorTeamRole,
          actorGlobalRole,
          restriction,
        );
      }
      if (input.dueDate !== undefined) {
        assertCanEditDate(
          'dueDate',
          existing.dueDate,
          input.dueDate,
          actorTeamRole,
          actorGlobalRole,
          restriction,
        );
      }
      if (input.plannedDate !== undefined) {
        assertCanEditDate(
          'plannedDate',
          existing.plannedDate,
          input.plannedDate,
          actorTeamRole,
          actorGlobalRole,
          restriction,
        );
      }
      if (input.completedAt !== undefined) {
        assertCanEditDate(
          'completedAt',
          existing.completedAt,
          input.completedAt,
          actorTeamRole,
          actorGlobalRole,
          restriction,
        );
      }
    }

    // v1.29: dependency status-guard. When the InstanceSetting
    // `tasks.dependencyEnforcement` is "block", reject moves to
    // IN_PROGRESS / DONE while there's at least one incomplete
    // FINISH_TO_START blocker. "off" / "warn" never throw here — "warn"
    // surfaces an advisory in the UI without server-side enforcement.
    if (input.status !== undefined && input.status !== existing.status) {
      await _deps.assertStatusTransitionAllowed(taskId, input.status);
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
      // v1.37: started-on date. Same audit treatment as the other dates.
      'startDate',
      'dueDate',
      'plannedDate',
      'completedAt',
    ] as const;
    const DATE_FIELDS = new Set(['startDate', 'dueDate', 'plannedDate', 'completedAt']);
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

    const dueRoll =
      input.dueDate !== undefined && input.dueDate !== null
        ? await resolveDueDateForScheduling(input.dueDate)
        : null;

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
            ...(input.technicianId !== undefined && { technicianId: input.technicianId }),
            ...(input.startDate !== undefined && {
              startDate: input.startDate === null ? null : new Date(input.startDate),
            }),
            ...(input.dueDate !== undefined && {
              dueDate:
                input.dueDate === null ? null : (dueRoll?.dueDate ?? new Date(input.dueDate)),
              // Reset the TASK_DUE notification flag whenever dueDate changes
              // so the scheduler treats the new date as fresh and notifies again.
              dueNotifiedAt: null,
            }),
            ...(input.plannedDate !== undefined && {
              plannedDate: input.plannedDate === null ? null : new Date(input.plannedDate),
            }),
            ...(resolvedCompletedAt !== undefined && { completedAt: resolvedCompletedAt }),
            // v1.42: budget patch.
            ...(normaliseBudget(input.plannedBudget) !== undefined && {
              plannedBudget: normaliseBudget(input.plannedBudget),
            }),
            ...(normaliseBudget(input.actualSpent) !== undefined && {
              actualSpent: normaliseBudget(input.actualSpent),
            }),
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
          // v1.29: fan-out unblock notifications when this transition is
          // TODO/IN_PROGRESS/REVIEW → DONE. Runs inside the transaction so a
          // rollback wipes both the status change and the notifications.
          if (input.status === 'DONE' && existing.status !== 'DONE') {
            await _deps.notifyUnblocked(tx, taskId, actorId);
          }
        }
        if (changedNonStatusFields.length > 0) {
          await logActivity(tx, {
            taskId,
            actorId,
            action: 'task.updated',
            meta: { fields: changedNonStatusFields },
          });
        }
        if (dueRoll?.rolled) {
          await logDueDateRoll(tx, {
            taskId,
            actorId,
            teamId,
            rolled: dueRoll.rolled,
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
        // v1.29: hydrate blocker count inside the same tx so the view
        // we return reflects post-commit state — important when the
        // transition itself just completed a dependent task (count
        // drops to 0).
        const blockerCount = await tx.taskDependency.count({
          where: {
            taskId,
            type: 'FINISH_TO_START',
            dependsOn: { status: { not: 'DONE' }, deletedAt: null },
          },
        });
        return {
          view: toView(updated, blockerCount),
          statusChanged,
          changedNonStatusFields,
          fromStatus: existing.status,
        };
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
      const hydrated = await withCustomFields(teamId, result.view);
      const { emitAutomationForTask } = await import('./automationEngine.js');
      if (result.statusChanged) {
        await emitAutomationForTask({
          teamId: result.view.teamId,
          projectId: result.view.projectId,
          taskId: result.view.id,
          triggerType: 'task.status_changed',
          task: hydrated,
          fromStatus: result.fromStatus,
          toStatus: result.view.status,
        });
      }
      if (result.changedNonStatusFields.length > 0) {
        await emitAutomationForTask({
          teamId: result.view.teamId,
          projectId: result.view.projectId,
          taskId: result.view.id,
          triggerType: 'task.updated',
          task: hydrated,
          changedFields: result.changedNonStatusFields,
        });
        if (result.changedNonStatusFields.includes('assigneeId')) {
          await emitAutomationForTask({
            teamId: result.view.teamId,
            projectId: result.view.projectId,
            taskId: result.view.id,
            triggerType: 'task.assigned',
            task: hydrated,
            changedFields: ['assigneeId'],
          });
        }
      }
      return hydrated;
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
    actorGlobalRole: GlobalRole,
    input: { status: TaskStatus; beforeTaskId: string | null },
  ): Promise<TaskView> {
    await assertCanWriteProject(projectId, teamId, actorId, actorGlobalRole);
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
      // v1.29: status guard also runs on the drag-and-drop reorder path so
      // a member can't sidestep the gate by dragging a card across columns.
      if (statusChanged) {
        await _deps.assertStatusTransitionAllowed(taskId, input.status);
      }
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
        if (input.status === 'DONE' && existing.status !== 'DONE') {
          await _deps.notifyUnblocked(tx, taskId, actorId);
        }
      }
      const blockerCount = await tx.taskDependency.count({
        where: {
          taskId,
          type: 'FINISH_TO_START',
          dependsOn: { status: { not: 'DONE' }, deletedAt: null },
        },
      });
      return toView(updated, blockerCount);
    }).then((view) => withCustomFields(teamId, view));
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

  // v1.21: Delete is now a SOFT delete. Stamps deletedAt + deletedById; the
  // row survives, hidden from list/get. Use restore() / purge() from the
  // Trash service to bring it back or destroy it permanently.
  async remove(
    teamId: string,
    projectId: string,
    taskId: string,
    actorId: string,
    actorGlobalRole: GlobalRole,
  ): Promise<void> {
    await assertCanWriteProject(projectId, teamId, actorId, actorGlobalRole);
    const existing = await this.get(teamId, projectId, taskId); // 404 if not in this project/team
    await prisma.task.update({
      where: { id: taskId },
      data: { deletedAt: new Date(), deletedById: actorId },
    });
    // Webhook subscribers DO want to know — the delete event fires from the
    // service layer because it's the only place we have the team scope after
    // the row is gone. Awaited so the delivery row exists synchronously.
    await _webhooks.emit(teamId, 'task.deleted', {
      taskId: existing.id, title: existing.title, projectId, teamId,
    });
  }
}

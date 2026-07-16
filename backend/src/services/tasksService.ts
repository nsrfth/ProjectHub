import { Prisma, type Currency, type GlobalRole, type PercentCompleteMode, type TaskPriority, type TaskStatus, type TeamRole } from '@prisma/client';
import { buildWbsPath, refreshIsSummary, repathDescendants } from '../lib/wbs.js';
import { prisma } from '../data/prisma.js';
import { AppError, Errors } from '../lib/errors.js';
import {
  assertCanWriteProject,
  isProjectEditDelegate,
  isUserEligibleTaskResponsible,
  listEligibleTaskResponsibleCandidates,
  resolveProjectAccess,
  type TaskResponsibleCandidate,
} from '../lib/projectAccess.js';
import { getDelegateCapabilities, type DelegateCapability } from '../lib/delegateCaps.js';
import { assertProjectDatesNotFrozen } from '../lib/projectFreeze.js';
import { assertEndOnOrAfterStart, normalizeOptionalCalendarDate } from '../lib/calendarDate.js';
import { logActivity } from './activityLogger.js';
import { statusCommentRequirement } from '../lib/statusComment.js';
import { bumpScheduleVersion } from '../lib/scheduleVersion.js';
import { invalidateCpmCache } from '../lib/cpm.js';
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
  // v1.86: a per-project full-edit delegate is treated like a manager for this
  // project's date fields (and only this project's).
  elevated: boolean,
): void {
  if (restriction !== 'manager-only') return;
  if (callerTeamRole === 'MANAGER' || callerGlobalRole === 'ADMIN' || elevated) return;
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

// v1.97 (PMIS R1): max WBS nesting depth (root = 0). A guard against pathological
// trees; deep enough for any real work-breakdown structure.
const MAX_WBS_DEPTH = 20;

// v1.97 (PMIS R1): one node of the derived WBS tree, returned flat in DFS
// pre-order by projectWbs(). wbsCode/wbsDepth/isSummary/rollup are computed at
// read time from the stored parentId + wbsOrder.
export interface WbsNodeView {
  id: string;
  parentId: string | null;
  title: string;
  status: TaskStatus;
  wbsCode: string;
  wbsDepth: number;
  isSummary: boolean;
  childCount: number;
  percentComplete: number;
  rollupPercentComplete: number;
  responsibleId: string | null;
  responsibleName: string | null;
  startDate: string | null;
  dueDate: string | null;
  baselineStart: string | null;
  baselineEnd: string | null;
}

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
  // v1.19: Subtask responsible — same semantics as Task.responsibleId.
  responsibleId: string | null;
  responsibleName: string | null;
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
  // v1.19 (renamed v1.77): "Responsible" — the person actually doing the
  // work. Defaults to creator at create-time; only team MANAGERS / global
  // ADMINs can change it after via `task.change_responsible`. responsibleName
  // is joined for the UI.
  responsibleId: string | null;
  responsibleName: string | null;
  // v1.87: approval gate. requiresApproval = per-task setting; approverId/Name
  // identify the designated approver (joined for the UI).
  requiresApproval: boolean;
  approverId: string | null;
  approverName: string | null;
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
  // v1.93 (PMIS R1): baseline/actual schedule dates + stored percent-complete.
  baselineStart: Date | null;
  baselineEnd: Date | null;
  actualStart: Date | null;
  actualEnd: Date | null;
  percentComplete: number;
  // v2.1.1 (PMIS R1 supplement): how percentComplete was last set.
  percentCompleteMode: PercentCompleteMode;
  // v1.42: optional task budget fields. Fixed-2 strings on the wire
  // (Decimal serializes to string to preserve precision); null when unset.
  plannedBudget: string | null;
  actualSpent: string | null;
  budgetCurrency: Currency;
  position: number;
  // v1.97 (PMIS R1): WBS parent id (null = root).
  parentId: string | null;
  // v2.1.1 (PMIS R1 supplement): materialized WBS columns.
  wbsDepth: number;
  isSummary: boolean;
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
  // v1.19: pull subtask responsible name in the same query so the UI doesn't
  // need to look up users separately. Same for the task itself below.
  // v1.42: also pull subtask assignee name.
  subtasks: {
    orderBy: { position: 'asc' },
    include: {
      responsible: { select: { name: true } },
      assignee: { select: { name: true } },
    },
  },
  responsible: { select: { name: true } },
  // v1.87: approver name joined for the UI (approval gate).
  approver: { select: { name: true } },
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
    responsibleId: row.responsibleId,
    responsibleName: row.responsible?.name ?? null,
    requiresApproval: row.requiresApproval,
    approverId: row.approverId,
    approverName: row.approver?.name ?? null,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    startDate: row.startDate,
    dueDate: row.dueDate,
    plannedDate: row.plannedDate,
    completedAt: row.completedAt,
    baselineStart: row.baselineStart,
    baselineEnd: row.baselineEnd,
    actualStart: row.actualStart,
    actualEnd: row.actualEnd,
    percentComplete: row.percentComplete,
    percentCompleteMode: row.percentCompleteMode,
    // v1.42: Decimal → fixed-2 string. Mirrors v1.41 Project.toView.
    plannedBudget: row.plannedBudget === null ? null : row.plannedBudget.toFixed(2),
    actualSpent: row.actualSpent === null ? null : row.actualSpent.toFixed(2),
    budgetCurrency: row.project.budgetCurrency,
    position: row.position,
    parentId: row.parentId,
    wbsDepth: row.wbsDepth,
    isSummary: row.isSummary,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    labels: row.labels.map((tl) => ({ id: tl.label.id, name: tl.label.name, color: tl.label.color })),
    subtasks: row.subtasks.map((s) => ({
      id: s.id,
      taskId: s.taskId,
      title: s.title,
      done: s.done,
      status: s.status,
      responsibleId: s.responsibleId,
      responsibleName: s.responsible?.name ?? null,
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

// v1.78.2: validate a set of label ids against the task's team. Deduplicates,
// then verifies every id resolves to a Label in this team. Rejects cross-team
// ids with 400 — keeps team isolation, mirroring the existing
// labelsService.attach guard. Returns the deduplicated list of ids that
// the caller should write into TaskLabel.
async function assertLabelsInTeam(teamId: string, labelIds: string[]): Promise<string[]> {
  const unique = Array.from(new Set(labelIds));
  if (unique.length === 0) return unique;
  const rows = await prisma.label.findMany({
    // v1.80: accept the team's own labels OR global predefined labels (teamId NULL).
    where: { id: { in: unique }, OR: [{ teamId }, { teamId: null }] },
    select: { id: true },
  });
  if (rows.length !== unique.length) {
    // Don't disclose which ids were cross-team vs. nonexistent — the
    // generic 400 matches the existing attach() 404 posture (never leak
    // existence of other teams' resources).
    throw Errors.badRequest('One or more labels do not belong to this team');
  }
  return unique;
}

// v2.1.1: maps TaskStatus → a canonical percentComplete for FROM_STATUS mode.
function statusToPercent(status: TaskStatus): number {
  const map: Record<TaskStatus, number> = {
    TODO: 0,
    IN_PROGRESS: 50,
    // v2.5.58: a held task keeps mid-flight progress — same as IN_PROGRESS.
    ON_HOLD: 50,
    REVIEW: 75,
    PENDING_APPROVAL: 90,
    DONE: 100,
  };
  return map[status] ?? 0;
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
      // v1.78: optional at create — omitted defaults to creator.
      responsibleId?: string | null;
      // v1.87: optional approval gate.
      requiresApproval?: boolean;
      approverId?: string | null;
      // v1.37: started-on date. Same shape as the other date fields.
      // Auto-set isn't worth the surprise — left as user-supplied only.
      startDate?: string | null;
      dueDate?: string | null;
      plannedDate?: string | null;
      completedAt?: string | null;
      // v1.93 (PMIS R1): baseline/actual dates + percent-complete.
      baselineStart?: string | null;
      baselineEnd?: string | null;
      actualStart?: string | null;
      actualEnd?: string | null;
      percentComplete?: number;
      // v2.1.1 (PMIS R1 supplement): how percentComplete is interpreted.
      percentCompleteMode?: PercentCompleteMode;
      // v1.42: optional budget pair. number | string | null.
      plannedBudget?: number | string | null;
      actualSpent?: number | string | null;
      // v1.78.2: optional list of team-label ids to attach at create
      // time. Empty array / omitted = no labels. Validated to belong to
      // the task's team (cross-team → 400). Deduped before insert.
      labelIds?: string[];
      // v1.97 (PMIS R1): optional WBS parent (live task in this project).
      parentId?: string | null;
    },
    opts?: { intake?: boolean },
  ): Promise<TaskView> {
    if (opts?.intake) {
      if (creatorGlobalRole !== 'ADMIN') {
        const membership = await prisma.teamMembership.findUnique({
          where: { userId_teamId: { userId: creatorId, teamId } },
        });
        if (!membership) throw Errors.forbidden('Not a team member');
      }
    } else {
      await assertCanWriteProject(projectId, teamId, creatorId, creatorGlobalRole);
    }
    await this.ensureProjectInTeam(teamId, projectId);

    if (input.assigneeId) {
      // Only allow assigning to someone who can see the task: a home-team
      // member, or (v2.5.58) a member of a FULL-shared guest team.
      const membership = await prisma.teamMembership.findUnique({
        where: { userId_teamId: { userId: input.assigneeId, teamId } },
      });
      if (!membership) {
        const sharedMember = await prisma.teamMembership.findFirst({
          where: {
            userId: input.assigneeId,
            team: { projectShares: { some: { projectId, level: 'FULL' } } },
          },
        });
        if (!sharedMember) throw Errors.badRequest('Assignee is not a member of this team');
      }
    }

    // v2.5.58: while the project plan is frozen, new tasks may be created but
    // not with plan dates (that would change the schedule). Reality capture
    // (completedAt) is deliberately not gated.
    if (
      input.startDate != null ||
      input.dueDate != null ||
      input.plannedDate != null ||
      input.baselineStart != null ||
      input.baselineEnd != null
    ) {
      await assertProjectDatesNotFrozen(projectId);
    }

    const startDate =
      input.startDate === undefined || input.startDate === null
        ? null
        : (normalizeOptionalCalendarDate(input.startDate) ?? null);

    const dueResolved = input.dueDate
      ? await resolveDueDateForScheduling(input.dueDate)
      : { dueDate: null as Date | null, rolled: null };

    if (startDate && dueResolved.dueDate) {
      try {
        assertEndOnOrAfterStart(startDate, dueResolved.dueDate);
      } catch {
        throw Errors.badRequest('dueDate must be on or after startDate');
      }
    }

    let responsibleId: string | null;
    if (input.responsibleId === undefined) {
      responsibleId = creatorId;
    } else {
      responsibleId = input.responsibleId;
      if (responsibleId !== null) {
        const eligible = await isUserEligibleTaskResponsible(teamId, projectId, responsibleId);
        if (!eligible) {
          throw Errors.badRequest('Responsible is not eligible for this project');
        }
      }
    }

    // v1.87: approval gate. An approver (when set) must be project-eligible
    // (same pool as responsible); turning requiresApproval on needs one.
    const requiresApproval = input.requiresApproval ?? false;
    const approverId = input.approverId ?? null;
    if (requiresApproval && !approverId) {
      throw Errors.badRequest('approverId is required when requiresApproval is true');
    }
    if (approverId) {
      const approverEligible = await isUserEligibleTaskResponsible(teamId, projectId, approverId);
      if (!approverEligible) throw Errors.badRequest('Approver is not eligible for this project');
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

    // v1.97 (PMIS R1): WBS placement. Validate the parent is a live task in this
    // project, then append the new task as the last child of that parent (or as
    // the last root when parentId is null). Same sparse-less append shape as the
    // kanban position above, but keyed on (projectId, parentId).
    let wbsParentId: string | null = null;
    let parentWbsPath: string | null = null;
    let parentWbsDepth = -1;
    if (input.parentId) {
      const parent = await prisma.task.findFirst({
        where: { id: input.parentId, projectId, deletedAt: null },
        select: { id: true, wbsPath: true, wbsDepth: true },
      });
      if (!parent) throw Errors.badRequest('Parent task not found in this project');
      wbsParentId = input.parentId;
      parentWbsPath = parent.wbsPath;
      parentWbsDepth = parent.wbsDepth;
    }
    const newWbsDepth = wbsParentId !== null ? parentWbsDepth + 1 : 0;
    const lastSibling = await prisma.task.findFirst({
      where: { projectId, parentId: wbsParentId, deletedAt: null },
      orderBy: { wbsOrder: 'desc' },
      select: { wbsOrder: true },
    });
    const wbsOrder = (lastSibling?.wbsOrder ?? -1) + 1;

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

    const dueResolvedForCreate = dueResolved;

    // v1.78.2: validate label ids OUTSIDE the transaction so the cross-team
    // 400 surfaces before we lock the task table for write.
    const validatedLabelIds =
      input.labelIds && input.labelIds.length > 0
        ? await assertLabelsInTeam(teamId, input.labelIds)
        : [];

    return prisma.$transaction(async (tx) => {
      const task = await tx.task.create({
        data: {
          teamId,
          projectId,
          creatorId,
          assigneeId: input.assigneeId ?? null,
          responsibleId,
          title: input.title,
          description: input.description ?? null,
          status,
          priority: input.priority ?? 'MEDIUM',
          requiresApproval,
          approverId,
          startDate,
          dueDate: dueResolvedForCreate.dueDate,
          plannedDate: input.plannedDate ? new Date(input.plannedDate) : null,
          completedAt,
          ...(input.baselineStart !== undefined && {
            baselineStart: input.baselineStart === null ? null : new Date(input.baselineStart),
          }),
          ...(input.baselineEnd !== undefined && {
            baselineEnd: input.baselineEnd === null ? null : new Date(input.baselineEnd),
          }),
          ...(input.actualStart !== undefined && {
            actualStart: input.actualStart === null ? null : new Date(input.actualStart),
          }),
          ...(input.actualEnd !== undefined && {
            actualEnd: input.actualEnd === null ? null : new Date(input.actualEnd),
          }),
          ...(input.percentComplete !== undefined && { percentComplete: input.percentComplete }),
          percentCompleteMode: input.percentCompleteMode ?? 'FROM_CHILDREN',
          position,
          // v1.97 (PMIS R1): WBS placement.
          parentId: wbsParentId,
          wbsOrder,
          wbsDepth: newWbsDepth,
          isSummary: false,
          // wbsPath is set via a follow-up update (needs the task id).
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
      // v2.1.1: set the materialized wbsPath now that we have the task id.
      const wbsPath = buildWbsPath(parentWbsPath, task.id);
      await tx.task.update({ where: { id: task.id }, data: { wbsPath } });
      // Mark the parent as a summary task (it now has at least one live child).
      await refreshIsSummary(tx, wbsParentId);
      // v1.78.2: bulk-attach validated labels. createMany is one INSERT
      // (no row-by-row round trips); skipDuplicates is defensive — the
      // task is newly created so no collision should happen in practice.
      // We then re-fetch with TASK_INCLUDE so the returned view's
      // `labels` array reflects the new attachments (the original create
      // returned an empty `labels` array since the join rows didn't
      // exist yet at that point in the transaction).
      let rowForView = task;
      if (validatedLabelIds.length > 0) {
        await tx.taskLabel.createMany({
          data: validatedLabelIds.map((labelId) => ({ taskId: task.id, labelId })),
          skipDuplicates: true,
        });
        const refreshed = await tx.task.findUnique({
          where: { id: task.id },
          include: TASK_INCLUDE,
        });
        if (refreshed) rowForView = refreshed;
      }
      await logActivity(tx, {
        taskId: task.id,
        actorId: creatorId,
        action: 'task.created',
        meta: { title: task.title, status: task.status, priority: task.priority },
      });
      if (dueResolvedForCreate.rolled) {
        await logDueDateRoll(tx, {
          taskId: task.id,
          actorId: creatorId,
          teamId,
          rolled: dueResolvedForCreate.rolled,
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
      // v1.78.2: rowForView is `task` when no labels were attached
      // (the existing snapshot is fine) or the re-fetched task with the
      // populated labels array when labels were attached.
      return toView(rowForView, blockerCount);
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

  async listResponsibleCandidates(
    teamId: string,
    projectId: string,
    callerId: string,
    callerGlobalRole: GlobalRole,
  ): Promise<TaskResponsibleCandidate[]> {
    await assertCanWriteProject(projectId, teamId, callerId, callerGlobalRole);
    await this.ensureProjectInTeam(teamId, projectId);
    return listEligibleTaskResponsibleCandidates(teamId, projectId);
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
      // v1.19: changing responsibleId requires team MANAGER or global ADMIN.
      // Undefined = leave as-is; explicit null = clear (also gated).
      responsibleId?: string | null;
      // v1.87: toggle the approval gate / change the approver.
      requiresApproval?: boolean;
      approverId?: string | null;
      // v1.37: started-on date. Subject to the same v1.18 manager-only
      // gate as the other date fields.
      startDate?: string | null;
      dueDate?: string | null;
      plannedDate?: string | null;
      completedAt?: string | null;
      // v1.93 (PMIS R1): baseline/actual dates + percent-complete.
      baselineStart?: string | null;
      baselineEnd?: string | null;
      actualStart?: string | null;
      actualEnd?: string | null;
      percentComplete?: number;
      // v2.1.1 (PMIS R1 supplement): how percentComplete is interpreted.
      percentCompleteMode?: PercentCompleteMode;
      isMilestone?: boolean;
      milestoneKind?: string | null;
      // v1.42: budget patch — undefined leaves, null clears.
      plannedBudget?: number | string | null;
      actualSpent?: number | string | null;
      // v1.78.2: replace-set on labels. undefined = leave the task's
      // current labels alone; an array (incl. []) replaces the entire
      // set. Each id must belong to this team (cross-team → 400).
      labelIds?: string[];
      // v2.5.58: explanatory comment persisted with the status change
      // (required for transitions into ON_HOLD / DONE).
      statusComment?: string;
    },
  ): Promise<TaskView> {
    // v1.88: capability-aware authorization. ADMIN / WRITE callers (owner,
    // write_all, FULL delegate, group-FULL) may edit titles + details; a partial
    // (granular) delegate may edit only the field groups their capabilities
    // cover. Date / responsible edits stay behind their own gates further down.
    const isAdmin = actorGlobalRole === 'ADMIN';
    const access = isAdmin
      ? 'WRITE'
      : await resolveProjectAccess(projectId, teamId, actorId, actorGlobalRole, 'nested');
    if (access === 'NONE') throw Errors.notFound('Project not found');
    const caps = isAdmin ? null : await getDelegateCapabilities(projectId, actorId);
    const hasWrite = access === 'WRITE';
    const can = (cap: DelegateCapability): boolean =>
      hasWrite || (caps ? caps.has(cap) : false);
    const existing = await this.get(teamId, projectId, taskId);

    // v1.78.2: validate labelIds outside the transaction so cross-team
    // 400 surfaces before any write. Skipped when undefined (leave-as-is).
    let validatedReplaceLabelIds: string[] | undefined;
    if (input.labelIds !== undefined) {
      validatedReplaceLabelIds = await assertLabelsInTeam(teamId, input.labelIds);
    }

    if (input.assigneeId) {
      const membership = await prisma.teamMembership.findUnique({
        where: { userId_teamId: { userId: input.assigneeId, teamId } },
      });
      if (!membership) {
        // v2.5.58: members of FULL-shared guest teams are assignable too.
        const sharedMember = await prisma.teamMembership.findFirst({
          where: {
            userId: input.assigneeId,
            team: { projectShares: { some: { projectId, level: 'FULL' } } },
          },
        });
        if (!sharedMember) throw Errors.badRequest('Assignee is not a member of this team');
      }
    }

    // v1.87: approval-config change (toggle requiresApproval / set the approver).
    // An approver (when set) must be project-eligible (same pool as responsible);
    // turning requiresApproval on needs one. Computed here so the DONE-gate below
    // sees the effective values even when the same PATCH toggles them.
    const nextRequiresApproval =
      input.requiresApproval !== undefined ? input.requiresApproval : existing.requiresApproval;
    const nextApproverId =
      input.approverId !== undefined ? input.approverId : existing.approverId;
    if (input.requiresApproval !== undefined || input.approverId !== undefined) {
      if (input.approverId != null) {
        const approverEligible = await isUserEligibleTaskResponsible(teamId, projectId, input.approverId);
        if (!approverEligible) throw Errors.badRequest('Approver is not eligible for this project');
      }
      if (nextRequiresApproval && !nextApproverId) {
        throw Errors.badRequest('approverId is required when requiresApproval is true');
      }
    }

    // v1.88: per-project granular delegation. Authorize each touched field group
    // against the caller's capabilities. WRITE callers pass titles + details
    // here; date / responsible edits additionally go through their own gates
    // below — and a delegate holding the matching capability lifts the
    // manager-only gate, exactly as a FULL delegate did pre-v1.88.
    const touchesDates =
      input.startDate !== undefined ||
      input.dueDate !== undefined ||
      input.plannedDate !== undefined ||
      input.completedAt !== undefined ||
      // v1.93: baseline/actual dates are manager-gated like the rest.
      input.baselineStart !== undefined ||
      input.baselineEnd !== undefined ||
      input.actualStart !== undefined ||
      input.actualEnd !== undefined;
    // v2.5.58: plan freeze — blocks PLAN dates only. completedAt and
    // actualStart/actualEnd record reality and stay editable while frozen.
    const touchesPlanDates =
      input.startDate !== undefined ||
      input.dueDate !== undefined ||
      input.plannedDate !== undefined ||
      input.baselineStart !== undefined ||
      input.baselineEnd !== undefined;
    if (touchesPlanDates) {
      await assertProjectDatesNotFrozen(projectId);
    }
    const touchesResponsible =
      input.responsibleId !== undefined && input.responsibleId !== existing.responsibleId;
    const touchesDetails =
      input.description !== undefined ||
      input.status !== undefined ||
      input.priority !== undefined ||
      input.assigneeId !== undefined ||
      input.labelIds !== undefined ||
      input.requiresApproval !== undefined ||
      input.approverId !== undefined ||
      input.plannedBudget !== undefined ||
      input.actualSpent !== undefined ||
      // v1.93: percent-complete is a progress detail (EDIT_DETAILS).
      input.percentComplete !== undefined;
    if (input.title !== undefined && !can('EDIT_TITLES')) {
      throw Errors.forbidden('Missing capability to edit the task title');
    }
    if (touchesDetails && !can('EDIT_DETAILS')) {
      throw Errors.forbidden('Missing capability to edit task details');
    }
    if (touchesDates && !can('EDIT_DATES')) {
      throw Errors.forbidden('Missing capability to edit task dates');
    }
    if (touchesResponsible && !can('CHANGE_RESPONSIBLE')) {
      throw Errors.forbidden('Missing capability to change the responsible');
    }
    // The manager-only date gate and the change_responsible gate are lifted for
    // a delegate holding the matching capability (FULL holds both, via expansion).
    const elevatedDates = caps?.has('EDIT_DATES') ?? false;
    const elevatedResponsible = caps?.has('CHANGE_RESPONSIBLE') ?? false;

    // v1.19 → v1.23: responsible change gate. Now gated by the
    // `task.change_responsible` permission (default = Manager only). Custom
    // roles can grant it independently of the legacy MANAGER bit.
    // v1.86: a per-project full-edit delegate also passes.
    if (touchesResponsible) {
      if (
        !elevatedResponsible &&
        !(await userHasPermission(actorId, teamId, actorGlobalRole, 'task.change_responsible'))
      ) {
        throw Errors.forbidden(
          'Missing permission: task.change_responsible',
        );
      }
      if (input.responsibleId != null) {
        const eligible = await isUserEligibleTaskResponsible(
          teamId,
          projectId,
          input.responsibleId,
        );
        if (!eligible) {
          throw Errors.badRequest('Responsible is not eligible for this project');
        }
      }
    }

    // v1.18: date-edit restriction. Only consulted when the caller is
    // touching one of the date fields; the DB read is cheap but
    // skipping it on no-op patches keeps the hot path quick.
    // v1.37: startDate joins dueDate / plannedDate / completedAt under
    // the same gate — same semantics (commitment change).
    if (touchesDates) {
      const restriction = await readDateEditRestriction();
      if (input.startDate !== undefined) {
        assertCanEditDate(
          'startDate',
          existing.startDate,
          input.startDate,
          actorTeamRole,
          actorGlobalRole,
          restriction,
          elevatedDates,
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
          elevatedDates,
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
          elevatedDates,
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
          elevatedDates,
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

    // v2.5.58: mandatory explanatory comment on gated transitions — entering
    // ON_HOLD (hold reason) or requesting DONE (completion summary). Evaluated
    // on the REQUESTED status, before the approval reroute below, so the
    // summary is captured at claim time even when the task lands in
    // PENDING_APPROVAL. The comment row itself is written inside the
    // transaction further down, next to the status-change activity entry.
    const commentRequirement =
      input.status !== undefined && input.status !== existing.status
        ? statusCommentRequirement(existing.status, input.status)
        : null;
    if (commentRequirement && !input.statusComment) {
      throw new AppError(400, 'STATUS_COMMENT_REQUIRED', 'A comment is required for this status change', {
        requiredFor: commentRequirement,
      });
    }

    // v1.87: approval gate on "completion". Moving a require-approval task to
    // DONE routes it to PENDING_APPROVAL instead — unless the actor is a
    // finalizer (the designated approver, a team MANAGER, a global ADMIN, or a
    // per-project full-edit delegate), who completes it directly. The dependency
    // guard above already ran on the requested status (DONE), so a blocked task
    // can't slip into approval.
    let effectiveStatus = input.status;
    let routedToApproval = false;
    if (input.status === 'DONE' && input.status !== existing.status && nextRequiresApproval) {
      const isFinalizer =
        actorId === nextApproverId ||
        actorTeamRole === 'MANAGER' ||
        actorGlobalRole === 'ADMIN' ||
        (await isProjectEditDelegate(projectId, actorId));
      if (!isFinalizer) {
        effectiveStatus = 'PENDING_APPROVAL';
        routedToApproval = true;
      }
    }

    // Moving across status columns: re-append to the end of the new column so
    // the task lands somewhere sensible. Reordering within a column is a
    // future endpoint (drag-and-drop UI).
    let nextPosition = existing.position;
    const statusChanged = effectiveStatus !== undefined && effectiveStatus !== existing.status;
    if (statusChanged) {
      const last = await prisma.task.findFirst({
        where: { projectId, status: effectiveStatus },
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
    } else if (statusChanged && effectiveStatus === 'DONE' && existing.completedAt === null) {
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

    // v2.5.58: set inside the tx when a status comment is persisted; used for
    // the post-commit comment.added webhook (parity with CommentsService).
    let createdCommentId: string | null = null;

    try {
      const result = await prisma.$transaction(async (tx) => {
        const updated = await tx.task.update({
          where: { id: taskId },
          data: {
            ...(input.title !== undefined && { title: input.title }),
            ...(input.description !== undefined && { description: input.description }),
            ...(effectiveStatus !== undefined && { status: effectiveStatus, position: nextPosition }),
            ...(input.priority !== undefined && { priority: input.priority }),
            ...(input.assigneeId !== undefined && { assigneeId: input.assigneeId }),
            ...(input.responsibleId !== undefined && { responsibleId: input.responsibleId }),
            ...(input.requiresApproval !== undefined && { requiresApproval: input.requiresApproval }),
            ...(input.approverId !== undefined && { approverId: input.approverId }),
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
            ...(input.baselineStart !== undefined && {
              baselineStart: input.baselineStart === null ? null : new Date(input.baselineStart),
            }),
            ...(input.baselineEnd !== undefined && {
              baselineEnd: input.baselineEnd === null ? null : new Date(input.baselineEnd),
            }),
            ...(input.actualStart !== undefined && {
              actualStart: input.actualStart === null ? null : new Date(input.actualStart),
            }),
            ...(input.actualEnd !== undefined && {
              actualEnd: input.actualEnd === null ? null : new Date(input.actualEnd),
            }),
            ...(input.percentComplete !== undefined && { percentComplete: input.percentComplete }),
            ...(input.percentCompleteMode !== undefined && { percentCompleteMode: input.percentCompleteMode }),
            ...(input.isMilestone !== undefined && { isMilestone: input.isMilestone }),
            ...(input.milestoneKind !== undefined && { milestoneKind: input.milestoneKind }),
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

        const touchesSchedule =
          touchesDates ||
          input.isMilestone !== undefined ||
          input.milestoneKind !== undefined;
        if (touchesSchedule) {
          await bumpScheduleVersion(tx, projectId);
        }

        // v1.78.2: replace-set semantics.
        // transaction (no diff/merge — simpler, and createMany with
        // skipDuplicates would not remove labels the user un-checked).
        // Re-fetch the row so `labels[]` in the returned view reflects
        // the post-replace state.
        let postLabelsRow = updated;
        if (validatedReplaceLabelIds !== undefined) {
          await tx.taskLabel.deleteMany({ where: { taskId } });
          if (validatedReplaceLabelIds.length > 0) {
            await tx.taskLabel.createMany({
              data: validatedReplaceLabelIds.map((labelId) => ({ taskId, labelId })),
              skipDuplicates: true,
            });
          }
          const refreshed = await tx.task.findUnique({
            where: { id: taskId },
            include: TASK_INCLUDE,
          });
          if (refreshed) postLabelsRow = refreshed;
        }

        // Emit one status-change row and (separately) one updated-fields row
        // so the timeline reads naturally. A no-op PATCH (everything matched)
        // emits nothing — don't spam the audit log.
        if (statusChanged) {
          const newStatus = effectiveStatus as TaskStatus;
          await logActivity(tx, {
            taskId,
            actorId,
            action: 'task.status_changed',
            meta: { from: existing.status, to: newStatus },
          });
          // v1.87: explicit approval-request entry when a completion was routed
          // to PENDING_APPROVAL (separate from the generic status change).
          if (routedToApproval) {
            await logActivity(tx, {
              taskId,
              actorId,
              action: 'task.approval_requested',
              meta: { approverId: nextApproverId },
            });
          }
          // v2.5.58: persist the status comment as a REAL Comment row in the
          // same tx — hold reasons / completion summaries appear in the task's
          // comment feed, not just the activity log. Also written when the
          // caller volunteers a comment on a non-gated transition.
          if (input.statusComment) {
            const c = await tx.comment.create({
              data: { taskId, authorId: actorId, body: input.statusComment },
            });
            await logActivity(tx, {
              taskId,
              actorId,
              action: 'comment.added',
              meta: {
                commentId: c.id,
                excerpt: input.statusComment.slice(0, 120),
                statusContext: { from: existing.status, to: newStatus },
              },
            });
            await notifications.onCommentAdded(tx, {
              taskId,
              projectId: existing.projectId,
              teamId: existing.teamId,
              actorId,
              commentId: c.id,
              excerpt: input.statusComment.slice(0, 120),
              taskTitle: updated.title,
            });
            createdCommentId = c.id;
          }
          await notifications.onStatusChanged(tx, {
            taskId,
            projectId: existing.projectId,
            teamId: existing.teamId,
            actorId,
            from: existing.status,
            to: newStatus,
            taskTitle: updated.title,
          });
          // v1.29 / v1.83: fan-out unblock notifications. A → DONE frees
          // FS + FF dependents; A → IN_PROGRESS frees SS dependents. Runs in
          // the transaction so a rollback wipes both the change + notifications.
          // (A completion routed to PENDING_APPROVAL is NOT done, so nothing unblocks.)
          if (
            (newStatus === 'DONE' || newStatus === 'IN_PROGRESS') &&
            newStatus !== existing.status
          ) {
            await _deps.notifyUnblocked(tx, taskId, newStatus, actorId);
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
          // v1.78.2: surface the post-label-replace snapshot when labels
          // were touched; otherwise `updated` already has TASK_INCLUDE.
          view: toView(postLabelsRow, blockerCount),
          statusChanged,
          changedNonStatusFields,
          fromStatus: existing.status,
        };
      });
      if (touchesDates || input.isMilestone !== undefined || input.milestoneKind !== undefined) {
        invalidateCpmCache(projectId);
      }
      // Post-commit webhook fan-out.
      // event from updated so subscribers can subscribe to only the signal
      // they care about. Awaited so the delivery row exists by the time
      // the response returns to the client (and by the time tests inspect).
      if (result.statusChanged) {
        await _webhooks.emit(result.view.teamId, 'task.status_changed', {
          task: result.view, from: result.fromStatus, to: result.view.status,
        });
      }
      // v2.5.58: status comments fan out to comment.added subscribers too, so
      // integrations see hold reasons / completion summaries like any comment.
      if (createdCommentId) {
        await _webhooks.emit(result.view.teamId, 'comment.added', {
          commentId: createdCommentId,
          taskId: result.view.id,
          taskTitle: result.view.title,
          teamId: result.view.teamId,
          statusContext: { from: result.fromStatus, to: result.view.status },
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

  // v1.87: approve a PENDING_APPROVAL task → DONE (completedAt stamped now).
  async approve(
    teamId: string,
    projectId: string,
    taskId: string,
    actorId: string,
    actorTeamRole: TeamRole,
    actorGlobalRole: GlobalRole,
  ): Promise<TaskView> {
    return this.decideApproval(teamId, projectId, taskId, actorId, actorTeamRole, actorGlobalRole, {
      decision: 'APPROVED',
    });
  }

  // v1.87: reject a PENDING_APPROVAL task → IN_PROGRESS, with a required reason.
  async reject(
    teamId: string,
    projectId: string,
    taskId: string,
    actorId: string,
    actorTeamRole: TeamRole,
    actorGlobalRole: GlobalRole,
    reason: string,
  ): Promise<TaskView> {
    return this.decideApproval(teamId, projectId, taskId, actorId, actorTeamRole, actorGlobalRole, {
      decision: 'REJECTED',
      reason,
    });
  }

  // Shared approve/reject path. Any project access reaches this (the global
  // requireProjectAccess hook) — the FINALIZER check here is the real gate, so
  // a designated approver who lacks project WRITE can still decide.
  private async decideApproval(
    teamId: string,
    projectId: string,
    taskId: string,
    actorId: string,
    actorTeamRole: TeamRole,
    actorGlobalRole: GlobalRole,
    decision:
      | { decision: 'APPROVED' }
      | { decision: 'REJECTED'; reason: string },
  ): Promise<TaskView> {
    const existing = await this.get(teamId, projectId, taskId);
    if (existing.status !== 'PENDING_APPROVAL') {
      throw Errors.badRequest('Task is not pending approval');
    }
    const isFinalizer =
      actorId === existing.approverId ||
      actorTeamRole === 'MANAGER' ||
      actorGlobalRole === 'ADMIN' ||
      (await isProjectEditDelegate(projectId, actorId));
    if (!isFinalizer) {
      throw Errors.forbidden('Not permitted to decide approval for this task');
    }

    const nextStatus: TaskStatus = decision.decision === 'APPROVED' ? 'DONE' : 'IN_PROGRESS';
    const last = await prisma.task.findFirst({
      where: { projectId, status: nextStatus },
      orderBy: { position: 'desc' },
      select: { position: true },
    });
    const nextPosition = (last?.position ?? 0) + POSITION_GAP;

    const view = await prisma.$transaction(async (tx) => {
      const updated = await tx.task.update({
        where: { id: taskId },
        data: {
          status: nextStatus,
          position: nextPosition,
          completedAt: decision.decision === 'APPROVED' ? new Date() : null,
        },
        include: TASK_INCLUDE,
      });
      await logActivity(tx, {
        taskId,
        actorId,
        action: decision.decision === 'APPROVED' ? 'task.approval_approved' : 'task.approval_rejected',
        meta: decision.decision === 'APPROVED' ? {} : { reason: decision.reason },
      });
      await logActivity(tx, {
        taskId,
        actorId,
        action: 'task.status_changed',
        meta: { from: 'PENDING_APPROVAL', to: nextStatus },
      });
      await notifications.onStatusChanged(tx, {
        taskId,
        projectId: existing.projectId,
        teamId: existing.teamId,
        actorId,
        from: 'PENDING_APPROVAL',
        to: nextStatus,
        taskTitle: updated.title,
      });
      // Approval → DONE frees FS/FF dependents; rejection → IN_PROGRESS frees SS.
      await _deps.notifyUnblocked(tx, taskId, nextStatus, actorId);
      const blockerCount = await tx.taskDependency.count({
        where: {
          taskId,
          type: 'FINISH_TO_START',
          dependsOn: { status: { not: 'DONE' }, deletedAt: null },
        },
      });
      return toView(updated, blockerCount);
    });

    const hydrated = await withCustomFields(teamId, view);
    await _webhooks.emit(hydrated.teamId, 'task.status_changed', {
      task: hydrated,
      from: 'PENDING_APPROVAL',
      to: nextStatus,
    });
    return hydrated;
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
    input: { status: TaskStatus; beforeTaskId: string | null; statusComment?: string },
  ): Promise<TaskView> {
    await assertCanWriteProject(projectId, teamId, actorId, actorGlobalRole);
    const existing = await this.get(teamId, projectId, taskId);
    if (input.beforeTaskId === taskId) {
      throw Errors.badRequest('Cannot reorder a task before itself');
    }

    // v2.5.58: drag-and-drop cannot sidestep the mandatory-comment gate.
    const commentRequirement =
      input.status !== existing.status
        ? statusCommentRequirement(existing.status, input.status)
        : null;
    if (commentRequirement && !input.statusComment) {
      throw new AppError(400, 'STATUS_COMMENT_REQUIRED', 'A comment is required for this status change', {
        requiredFor: commentRequirement,
      });
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
        // v2.5.58: persist the drag's status comment as a real Comment row in
        // the same tx (see update() for the rationale).
        if (input.statusComment) {
          const c = await tx.comment.create({
            data: { taskId, authorId: actorId, body: input.statusComment },
          });
          await logActivity(tx, {
            taskId,
            actorId,
            action: 'comment.added',
            meta: {
              commentId: c.id,
              excerpt: input.statusComment.slice(0, 120),
              statusContext: { from: existing.status, to: input.status },
            },
          });
          await notifications.onCommentAdded(tx, {
            taskId,
            projectId: existing.projectId,
            teamId: existing.teamId,
            actorId,
            commentId: c.id,
            excerpt: input.statusComment.slice(0, 120),
            taskTitle: updated.title,
          });
        }
        await notifications.onStatusChanged(tx, {
          taskId,
          projectId: existing.projectId,
          teamId: existing.teamId,
          actorId,
          from: existing.status,
          to: input.status,
          taskTitle: updated.title,
        });
        if (
          (input.status === 'DONE' || input.status === 'IN_PROGRESS') &&
          input.status !== existing.status
        ) {
          await _deps.notifyUnblocked(tx, taskId, input.status, actorId);
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

  // v1.97 (PMIS R1): WBS move — reparent a task and/or reorder it among its
  // (new) siblings. newParentId null promotes it to a root. Guards: same
  // project + live parent, no self-parent, no cycle (can't move under a
  // descendant), and a depth cap. Sibling wbsOrder is renumbered sequentially.
  async move(
    teamId: string,
    projectId: string,
    taskId: string,
    actorId: string,
    actorGlobalRole: GlobalRole,
    input: { newParentId: string | null; position: number },
  ): Promise<TaskView> {
    await assertCanWriteProject(projectId, teamId, actorId, actorGlobalRole);

    const task = await prisma.task.findFirst({
      where: { id: taskId, projectId, deletedAt: null },
      select: { id: true, parentId: true, wbsPath: true, wbsDepth: true },
    });
    if (!task) throw Errors.notFound('Task not found');
    if (input.newParentId === taskId) {
      throw Errors.badRequest('A task cannot be its own parent');
    }

    const { newParentId } = input;
    if (newParentId !== null) {
      // Load (id, parentId) for every live task: validate the parent exists and
      // walk its ancestor chain in memory for cycle detection + depth.
      const rows = await prisma.task.findMany({
        where: { projectId, deletedAt: null },
        select: { id: true, parentId: true },
      });
      const parentOf = new Map(rows.map((r) => [r.id, r.parentId]));
      if (!parentOf.has(newParentId)) {
        throw Errors.badRequest('Parent task not found in this project');
      }
      let cur: string | null = newParentId;
      let parentDepth = 0;
      let hops = 0;
      while (cur !== null) {
        if (cur === taskId) {
          throw Errors.badRequest('Cannot move a task under its own descendant');
        }
        cur = parentOf.get(cur) ?? null;
        if (cur !== null) parentDepth += 1;
        if (++hops > MAX_WBS_DEPTH + 2) break; // defensive against a malformed chain
      }
      if (parentDepth + 1 > MAX_WBS_DEPTH) {
        throw Errors.badRequest('WBS nesting is too deep');
      }
    }

    await prisma.$transaction(async (tx) => {
      const siblings = await tx.task.findMany({
        where: { projectId, parentId: newParentId, deletedAt: null, NOT: { id: taskId } },
        orderBy: [{ wbsOrder: 'asc' }, { createdAt: 'asc' }],
        select: { id: true },
      });
      const ordered = siblings.map((s) => s.id);
      const insertAt = Math.min(Math.max(input.position, 0), ordered.length);
      ordered.splice(insertAt, 0, taskId);
      // Renumber the affected sibling group sequentially; set the moved task's
      // new parent in the same pass.
      for (let i = 0; i < ordered.length; i++) {
        await tx.task.update({
          where: { id: ordered[i] },
          data:
            ordered[i] === taskId ? { parentId: newParentId, wbsOrder: i } : { wbsOrder: i },
        });
      }
      // v2.1.1: update materialized WBS path + depth for task and its subtree.
      const newParentRow = newParentId
        ? await tx.task.findFirst({ where: { id: newParentId }, select: { wbsPath: true, wbsDepth: true } })
        : null;
      const oldPath = task.wbsPath ?? `/${taskId}`;
      const newPath = buildWbsPath(newParentRow?.wbsPath ?? null, taskId);
      const oldDepth = task.wbsDepth ?? 0;
      const newDepth = newParentRow ? newParentRow.wbsDepth + 1 : 0;
      await repathDescendants(tx, projectId, oldPath, newPath, newDepth - oldDepth);
      await tx.task.update({ where: { id: taskId }, data: { wbsPath: newPath, wbsDepth: newDepth } });
      // Update isSummary on old parent (it may have lost its last live child).
      const oldParentId = task.parentId;
      if (oldParentId !== newParentId) {
        await refreshIsSummary(tx, oldParentId);
      }
      // New parent always has at least one live child after this move.
      if (newParentId) {
        await tx.task.update({ where: { id: newParentId }, data: { isSummary: true } });
      }
    });

    return this.get(teamId, projectId, taskId);
  }

  // v1.97 (PMIS R1): build the project's WBS as a flat DFS pre-order list with
  // derived outline codes + leaf-weighted % rollups. Children of a soft-deleted
  // parent surface as roots (the read layer self-heals orphans). Pure read.
  async projectWbs(teamId: string, projectId: string): Promise<WbsNodeView[]> {
    await this.ensureProjectInTeam(teamId, projectId);
    const rows = await prisma.task.findMany({
      where: { projectId, deletedAt: null },
      select: {
        id: true,
        parentId: true,
        wbsOrder: true,
        createdAt: true,
        title: true,
        status: true,
        percentComplete: true,
        startDate: true,
        dueDate: true,
        baselineStart: true,
        baselineEnd: true,
        responsibleId: true,
        responsible: { select: { name: true } },
      },
    });

    type Row = (typeof rows)[number];
    const liveIds = new Set(rows.map((r) => r.id));
    const childrenOf = new Map<string | null, Row[]>();
    for (const r of rows) {
      // A parent that isn't live (trashed/purged) → treat the row as a root.
      const key = r.parentId && liveIds.has(r.parentId) ? r.parentId : null;
      const bucket = childrenOf.get(key);
      if (bucket) bucket.push(r);
      else childrenOf.set(key, [r]);
    }
    const sortSibs = (arr: Row[]): Row[] =>
      [...arr].sort(
        (a, b) => a.wbsOrder - b.wbsOrder || a.createdAt.getTime() - b.createdAt.getTime(),
      );

    const out: WbsNodeView[] = [];
    const visited = new Set<string>(); // defensive cycle guard (move prevents cycles)

    // DFS. Returns the subtree's { leafCount, weightedPct } so a summary node can
    // average over its leaves. Pushes pre-order; fixes rollup after recursing.
    const walk = (row: Row, code: string, depth: number): { leafCount: number; weightedPct: number } => {
      if (visited.has(row.id)) return { leafCount: 0, weightedPct: 0 };
      visited.add(row.id);
      const kids = sortSibs(childrenOf.get(row.id) ?? []);
      const isSummary = kids.length > 0;
      const node: WbsNodeView = {
        id: row.id,
        parentId: row.parentId && liveIds.has(row.parentId) ? row.parentId : null,
        title: row.title,
        status: row.status,
        wbsCode: code,
        wbsDepth: depth,
        isSummary,
        childCount: kids.length,
        percentComplete: row.percentComplete,
        rollupPercentComplete: row.percentComplete,
        responsibleId: row.responsibleId,
        responsibleName: row.responsible?.name ?? null,
        startDate: row.startDate ? row.startDate.toISOString() : null,
        dueDate: row.dueDate ? row.dueDate.toISOString() : null,
        baselineStart: row.baselineStart ? row.baselineStart.toISOString() : null,
        baselineEnd: row.baselineEnd ? row.baselineEnd.toISOString() : null,
      };
      out.push(node);
      if (!isSummary) {
        return { leafCount: 1, weightedPct: row.percentComplete };
      }
      let leafCount = 0;
      let weightedPct = 0;
      kids.forEach((kid, i) => {
        const sub = walk(kid, `${code}.${i + 1}`, depth + 1);
        leafCount += sub.leafCount;
        weightedPct += sub.weightedPct;
      });
      node.rollupPercentComplete = leafCount > 0 ? Math.round(weightedPct / leafCount) : 0;
      return { leafCount, weightedPct };
    };

    const roots = sortSibs(childrenOf.get(null) ?? []);
    roots.forEach((r, i) => walk(r, `${i + 1}`, 0));
    return out;
  }

  // v2.1.1 (PMIS R1 supplement): set percentComplete + mode atomically. Mode controls
  // how the value is derived: MANUAL = supplied value, FROM_STATUS = map task.status
  // to %, FROM_CHILDREN = weighted leaf rollup of the subtree at call time.
  async updateProgress(
    teamId: string,
    projectId: string,
    taskId: string,
    actorId: string,
    actorGlobalRole: GlobalRole,
    input: { percentComplete?: number; mode: PercentCompleteMode },
  ): Promise<TaskView> {
    await assertCanWriteProject(projectId, teamId, actorId, actorGlobalRole);
    const task = await prisma.task.findFirst({
      where: { id: taskId, projectId, deletedAt: null },
      select: { id: true, status: true },
    });
    if (!task) throw Errors.notFound('Task not found');

    let newPct: number;
    if (input.mode === 'MANUAL') {
      // Validated by the schema layer; checked here for the service signature.
      if (input.percentComplete === undefined) throw Errors.badRequest('percentComplete required for MANUAL mode');
      newPct = input.percentComplete;
    } else if (input.mode === 'FROM_STATUS') {
      newPct = statusToPercent(task.status);
    } else {
      // FROM_CHILDREN: snapshot the current rollup from the WBS tree.
      const wbsNodes = await this.projectWbs(teamId, projectId);
      const node = wbsNodes.find((n) => n.id === taskId);
      newPct = node?.rollupPercentComplete ?? 0;
    }

    await prisma.task.update({
      where: { id: taskId },
      data: { percentComplete: newPct, percentCompleteMode: input.mode },
    });
    await logActivity(prisma, {
      taskId,
      actorId,
      action: 'task.progress_updated',
      meta: { percentComplete: newPct, mode: input.mode },
    });
    return withCustomFields(teamId, await this.get(teamId, projectId, taskId));
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
    // v1.88: WRITE callers delete; a partial delegate needs DELETE_TASKS.
    const isAdmin = actorGlobalRole === 'ADMIN';
    const access = isAdmin
      ? 'WRITE'
      : await resolveProjectAccess(projectId, teamId, actorId, actorGlobalRole, 'nested');
    if (access === 'NONE') throw Errors.notFound('Project not found');
    if (
      access !== 'WRITE' &&
      !(await getDelegateCapabilities(projectId, actorId)).has('DELETE_TASKS')
    ) {
      throw Errors.forbidden('Read-only access to this project');
    }
    const existing = await this.get(teamId, projectId, taskId); // 404 if not in this project/team
    await prisma.$transaction(async (tx) => {
      await tx.task.update({
        where: { id: taskId },
        data: { deletedAt: new Date(), deletedById: actorId },
      });
      // v2.1.1: parent may no longer have any live children.
      await refreshIsSummary(tx, existing.parentId);
    });
    // Webhook subscribers DO want to know — the delete event fires from the
    // service layer because it's the only place we have the team scope after
    // the row is gone. Awaited so the delivery row exists synchronously.
    await _webhooks.emit(teamId, 'task.deleted', {
      taskId: existing.id, title: existing.title, projectId, teamId,
    });
  }
}

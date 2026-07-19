import { Prisma, type GlobalRole, type SubtaskStatus } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';
import { userHasPermission } from '../middleware/requirePermission.js';
import { assertAssignmentAllowed, resolveProjectAccess } from '../lib/projectAccess.js';
import { getDelegateCapabilities, type DelegateCapability } from '../lib/delegateCaps.js';
import { assertProjectDatesNotFrozen } from '../lib/projectFreeze.js';
import { logActivity } from './activityLogger.js';

// Subtasks are checklist items inside a task. The route layer already verifies
// team membership; this service additionally enforces that the subtask belongs
// to the (teamId, projectId, taskId) chain in the URL, so cross-tenant probes
// return 404 instead of leaking existence.

const POSITION_GAP = 1000;
// v1.35: two-phase reorder bumps every row into a collision-free range
// before settling. Matches the bucket reorder pattern.
const REORDER_BUMP = 1_000_000;

export interface SubtaskView {
  id: string;
  taskId: string;
  title: string;
  done: boolean;
  // v1.82: 5-state progress status; `done` above is derived (DONE ⇔ true).
  status: SubtaskStatus;
  responsibleId: string | null;
  responsibleName: string | null;
  // v1.42: assignee — distinct from responsible. Anyone with project
  // access can change; null when unassigned.
  assigneeId: string | null;
  assigneeName: string | null;
  // v1.41: optional scheduling window. Serialized as ISO strings on the
  // wire so the SPA can hand them straight to Date(...) / the picker.
  startDate: string | null;
  endDate: string | null;
  position: number;
}

const SUBTASK_INCLUDE = {
  responsible: { select: { name: true } },
  // v1.42: join assignee in the same query so the UI doesn't need a
  // separate user lookup.
  assignee: { select: { name: true } },
} as const;

function toView(row: Prisma.SubtaskGetPayload<{ include: typeof SUBTASK_INCLUDE }>): SubtaskView {
  return {
    id: row.id,
    taskId: row.taskId,
    title: row.title,
    done: row.done,
    status: row.status,
    responsibleId: row.responsibleId,
    responsibleName: row.responsible?.name ?? null,
    assigneeId: row.assigneeId,
    assigneeName: row.assignee?.name ?? null,
    startDate: row.startDate ? row.startDate.toISOString() : null,
    endDate: row.endDate ? row.endDate.toISOString() : null,
    position: row.position,
  };
}

// v1.42 → v2.6 (Phase 1C): the module-private `assertAssigneeInTeam` (bare
// team membership) is gone, replaced by the shared `assertAssignmentAllowed`
// from lib/projectAccess. Two deliberate consequences:
//   - LOOSER eligibility: an ACCEPTED group-grant member with project access
//     can now be a subtask assignee, matching the task-responsible rule. The
//     old check rejected them despite their legitimate WRITE.
//   - unit scope applies when ACCESS_UNIT_SCOPE is on.

// v1.41: end-on-or-after-start helper. Returns true when the pair is
// valid OR either side is null. Throws a 400 with a friendly reason
// code so the SPA can highlight the right field.
function assertDateRange(startDate: Date | null, endDate: Date | null): void {
  if (startDate && endDate && endDate.getTime() < startDate.getTime()) {
    throw Errors.badRequest('endDate must be on or after startDate', {
      reason: 'SUBTASK_DATE_RANGE_INVERTED',
    });
  }
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
    // v2.6 (Phase 1C): needed by the unit-scope check (ADMIN bypass).
    creatorGlobalRole: GlobalRole,
    input: {
      title: string;
      done?: boolean;
      // v1.82: optional initial status. Defaults to NOT_STARTED; `done` is
      // derived from it (DONE ⇔ true) so the two never diverge.
      status?: SubtaskStatus;
      startDate?: string | null;
      endDate?: string | null;
      // v1.42: optional assignee at create time.
      assigneeId?: string | null;
    },
  ): Promise<SubtaskView> {
    await this.ensureTaskInChain(teamId, projectId, taskId);
    // v2.5.58: no new plan dates while the project plan is frozen.
    if (input.startDate != null || input.endDate != null) {
      await assertProjectDatesNotFrozen(projectId);
    }
    // v1.41: date range validation. Zod has already enforced this on the
    // body, but the service is also called from tests/seed/etc. — keep
    // the rule here as the canonical guard.
    const startDate = input.startDate ? new Date(input.startDate) : null;
    const endDate = input.endDate ? new Date(input.endDate) : null;
    assertDateRange(startDate, endDate);
    // v1.42 → v2.6: shared eligibility + unit-scope guard (see note above).
    await assertAssignmentAllowed({
      teamId,
      projectId,
      actorId: creatorId,
      actorGlobalRole: creatorGlobalRole,
      targetId: input.assigneeId,
      role: 'assignee',
    });
    // Append to the end with the same sparse-position scheme as Task.
    const last = await prisma.subtask.findFirst({
      where: { taskId },
      orderBy: { position: 'desc' },
      select: { position: true },
    });
    const position = (last?.position ?? 0) + POSITION_GAP;
    // v1.82: derive a coherent (status, done) pair. status wins when given;
    // otherwise map the legacy done flag (true → DONE, false → NOT_STARTED).
    const initialStatus: SubtaskStatus =
      input.status ?? (input.done ? 'DONE' : 'NOT_STARTED');
    const created = await prisma.subtask.create({
      data: {
        taskId,
        title: input.title,
        status: initialStatus,
        done: initialStatus === 'DONE',
        // v1.19: creator becomes the default responsible (same rule as Task).
        responsibleId: creatorId,
        // v1.42: explicit assignee or null. Unlike responsible, we do NOT
        // default to creator — assignee is opt-in (matches Task.assigneeId
        // semantics, which is null unless set).
        assigneeId: input.assigneeId ?? null,
        startDate,
        endDate,
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
    input: {
      title?: string;
      done?: boolean;
      // v1.82: progress status. Authoritative — when set, `done` is derived
      // from it; when only `done` is set, status is derived from `done`.
      status?: SubtaskStatus;
      responsibleId?: string | null;
      // v1.42: assignee — undefined leaves, null clears, string sets.
      // Anyone with project access can change (unlike responsible, which
      // is manager-gated).
      assigneeId?: string | null;
      // v1.41: undefined = leave as-is; null = clear; string = set.
      startDate?: string | null;
      endDate?: string | null;
    },
  ): Promise<SubtaskView> {
    await this.ensureTaskInChain(teamId, projectId, taskId);
    const existing = await prisma.subtask.findUnique({ where: { id: subtaskId } });
    if (!existing || existing.taskId !== taskId) throw Errors.notFound('Subtask not found');

    // v1.88: capability-aware authorization. The PATCH route allows READ so a
    // granular delegate can reach here; enforce their per-field capabilities.
    // WRITE callers (admin, owner, write_all, FULL/group-FULL) pass everything
    // except the responsible gate below.
    const isAdmin = actorGlobalRole === 'ADMIN';
    const access = isAdmin
      ? 'WRITE'
      : await resolveProjectAccess(projectId, teamId, actorId, actorGlobalRole, 'nested');
    if (access === 'NONE') throw Errors.notFound('Project not found');
    const caps = isAdmin ? null : await getDelegateCapabilities(projectId, actorId);
    const hasWrite = access === 'WRITE';
    const can = (cap: DelegateCapability): boolean =>
      hasWrite || (caps ? caps.has(cap) : false);
    // v2.6 (Phase 1C): assignee/responsible self-service, aligned with the
    // v1.82 setStatus route — the subtask's own responsible or assignee may
    // change STATUS/DONE (and nothing else) without WRITE or a capability.
    // Deliberately the same allowance set as setStatus, so the full-PATCH path
    // and the focused status route cannot disagree about who may self-serve.
    const isSelfService =
      existing.assigneeId === actorId || existing.responsibleId === actorId;

    if (input.title !== undefined && !can('EDIT_TITLES')) {
      throw Errors.forbidden('Missing capability to edit the subtask title');
    }
    // assigneeId stays capability-gated even for the self-servicer: releasing
    // or re-pointing the assignment is a coordination act, not self-service.
    if (input.assigneeId !== undefined && !can('EDIT_DETAILS')) {
      throw Errors.forbidden('Missing capability to edit subtask details');
    }
    if (
      (input.done !== undefined || input.status !== undefined) &&
      !can('EDIT_DETAILS') &&
      !isSelfService
    ) {
      throw Errors.forbidden('Missing capability to edit subtask details');
    }
    if ((input.startDate !== undefined || input.endDate !== undefined) && !can('EDIT_DATES')) {
      throw Errors.forbidden('Missing capability to edit subtask dates');
    }
    // v2.5.58: plan freeze — subtask start/end are plan dates.
    if (input.startDate !== undefined || input.endDate !== undefined) {
      await assertProjectDatesNotFrozen(projectId);
    }
    if (
      input.responsibleId !== undefined &&
      input.responsibleId !== existing.responsibleId &&
      !can('CHANGE_RESPONSIBLE')
    ) {
      throw Errors.forbidden('Missing capability to change the responsible');
    }

    // v1.41: validate the merged date range, not just the body. A PATCH
    // that only sets `endDate` against an existing `startDate` must still
    // 400 if it inverts the window.
    const mergedStart =
      input.startDate === undefined
        ? existing.startDate
        : input.startDate === null
          ? null
          : new Date(input.startDate);
    const mergedEnd =
      input.endDate === undefined
        ? existing.endDate
        : input.endDate === null
          ? null
          : new Date(input.endDate);
    assertDateRange(mergedStart, mergedEnd);

    // v1.42 → v2.6: shared eligibility + unit-scope guard (see note above).
    if (input.assigneeId !== undefined) {
      await assertAssignmentAllowed({
        teamId,
        projectId,
        actorId,
        actorGlobalRole,
        targetId: input.assigneeId,
        role: 'assignee',
      });
    }

    // v1.19 → v1.23: responsible change gate. Now permission-driven.
    // v1.86: a per-project full-edit delegate also passes (this project only).
    if (input.responsibleId !== undefined && input.responsibleId !== existing.responsibleId) {
      const elevated = caps?.has('CHANGE_RESPONSIBLE') ?? false;
      if (
        !elevated &&
        !(await userHasPermission(actorId, teamId, actorGlobalRole, 'task.change_responsible'))
      ) {
        throw Errors.forbidden('Missing permission: task.change_responsible');
      }
      // v2.6 (Phase 1C): was a bare team-membership check — now the shared
      // guard, so subtask responsibles follow the same (looser) eligibility as
      // task responsibles, plus unit scope. The permission gate above stays:
      // it answers "may you change it at all", this answers "to THIS person".
      await assertAssignmentAllowed({
        teamId,
        projectId,
        actorId,
        actorGlobalRole,
        targetId: input.responsibleId,
        role: 'responsible',
      });
    }

    // v1.82: keep done <-> status coherent. status is the source of truth:
    // if status is provided, done = (status === DONE); otherwise a done toggle
    // maps to DONE / NOT_STARTED. (NOT_STARTED chosen for done=false.)
    let nextStatus: SubtaskStatus | undefined = input.status;
    let nextDone: boolean | undefined = input.done;
    if (nextStatus !== undefined) {
      nextDone = nextStatus === 'DONE';
    } else if (nextDone !== undefined) {
      nextStatus = nextDone ? 'DONE' : 'NOT_STARTED';
    }

    try {
      const updated = await prisma.subtask.update({
        where: { id: subtaskId },
        data: {
          ...(input.title !== undefined && { title: input.title }),
          ...(nextStatus !== undefined && { status: nextStatus }),
          ...(nextDone !== undefined && { done: nextDone }),
          ...(input.responsibleId !== undefined && { responsibleId: input.responsibleId }),
          ...(input.assigneeId !== undefined && { assigneeId: input.assigneeId }),
          ...(input.startDate !== undefined && { startDate: mergedStart }),
          ...(input.endDate !== undefined && { endDate: mergedEnd }),
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

  // v1.82: focused status-only change. Allowed for the subtask's RESPONSIBLE
  // person OR its ASSIGNEE OR anyone with the general subtask-edit permission
  // (= project WRITE access). A responsible/assignee who lacks WRITE can still
  // change THE STATUS of their subtask, but nothing else (this method only
  // touches status + the derived done). Project access (READ) is enforced by
  // the route; team/project scoping via ensureTaskInChain.
  async setStatus(
    teamId: string,
    projectId: string,
    taskId: string,
    subtaskId: string,
    actorId: string,
    actorGlobalRole: GlobalRole,
    status: SubtaskStatus,
  ): Promise<SubtaskView> {
    await this.ensureTaskInChain(teamId, projectId, taskId);
    const existing = await prisma.subtask.findUnique({ where: { id: subtaskId } });
    if (!existing || existing.taskId !== taskId) throw Errors.notFound('Subtask not found');

    let allowed = existing.responsibleId === actorId || existing.assigneeId === actorId;
    if (!allowed) {
      // General subtask-edit permission = project WRITE access (the gate on the
      // full PATCH route). resolveProjectAccess returns WRITE for ADMIN, owner,
      // project.write_all, or a FULL group grant.
      const access = await resolveProjectAccess(
        projectId,
        teamId,
        actorId,
        actorGlobalRole,
        'nested',
      );
      allowed = access === 'WRITE';
    }
    if (!allowed) {
      throw Errors.forbidden(
        'You can only change the status of a subtask you are responsible for or assigned to',
      );
    }

    const updated = await prisma.subtask.update({
      where: { id: subtaskId },
      data: { status, done: status === 'DONE' },
      include: SUBTASK_INCLUDE,
    });
    await logActivity(prisma, {
      taskId,
      teamId,
      actorId,
      action: 'subtask.status_changed',
      meta: { subtaskId, status, title: existing.title },
    });
    return toView(updated);
  }

  async remove(teamId: string, projectId: string, taskId: string, subtaskId: string): Promise<void> {
    await this.ensureTaskInChain(teamId, projectId, taskId);
    const existing = await prisma.subtask.findUnique({ where: { id: subtaskId } });
    if (!existing || existing.taskId !== taskId) throw Errors.notFound('Subtask not found');
    await prisma.subtask.delete({ where: { id: subtaskId } });
  }

  // v1.35: full-permutation reorder. Mirrors bucketsService.reorder —
  // strict mode (no duplicates / no missing / no foreign ids) and a
  // two-phase write so no intermediate state has duplicate `position`
  // values within a task. `position` stays non-unique (sort key, not
  // identity) — matches the Bucket.order / Task.position precedent.
  async reorder(
    teamId: string,
    projectId: string,
    taskId: string,
    input: { subtaskIds: string[] },
  ): Promise<SubtaskView[]> {
    await this.ensureTaskInChain(teamId, projectId, taskId);

    const ids = input.subtaskIds;
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) {
        throw Errors.badRequest(
          'Reorder list contains a duplicate subtask id',
          { reason: 'SUBTASK_REORDER_MISMATCH', duplicate: id },
        );
      }
      seen.add(id);
    }

    const result = await prisma.$transaction(async (tx) => {
      const current = await tx.subtask.findMany({
        where: { taskId },
        select: { id: true },
      });
      const currentIds = new Set(current.map((s) => s.id));

      if (current.length !== ids.length) {
        throw Errors.badRequest(
          `Reorder list must contain every subtask on the task (got ${ids.length}, expected ${current.length})`,
          { reason: 'SUBTASK_REORDER_MISMATCH', got: ids.length, expected: current.length },
        );
      }
      for (const id of ids) {
        if (!currentIds.has(id)) {
          throw Errors.badRequest(
            `Subtask ${id} is not on this task`,
            { reason: 'SUBTASK_REORDER_MISMATCH', strayId: id },
          );
        }
      }

      // Phase 1: lift every row into the collision-free range.
      await tx.subtask.updateMany({
        where: { taskId },
        data: { position: { increment: REORDER_BUMP } },
      });

      // Phase 2: settle to the requested order. We keep the POSITION_GAP
      // sparsity for parity with task position so future inline-insert
      // endpoints have room.
      for (let i = 0; i < ids.length; i++) {
        await tx.subtask.update({
          where: { id: ids[i]! },
          data: { position: (i + 1) * POSITION_GAP },
        });
      }

      return tx.subtask.findMany({
        where: { taskId },
        include: SUBTASK_INCLUDE,
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
      });
    });
    return result.map(toView);
  }
}

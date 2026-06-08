import { Prisma, type GlobalRole } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';
import { userHasPermission } from '../middleware/requirePermission.js';

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
  technicianId: string | null;
  technicianName: string | null;
  // v1.42: assignee — distinct from technician. Anyone with project
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
  technician: { select: { name: true } },
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
    technicianId: row.technicianId,
    technicianName: row.technician?.name ?? null,
    assigneeId: row.assigneeId,
    assigneeName: row.assignee?.name ?? null,
    startDate: row.startDate ? row.startDate.toISOString() : null,
    endDate: row.endDate ? row.endDate.toISOString() : null,
    position: row.position,
  };
}

// v1.42: shared assignee-must-be-team-member guard. Skip when clearing
// (null) or when omitted. Throws 400 with a friendly message.
async function assertAssigneeInTeam(
  teamId: string,
  assigneeId: string | null | undefined,
): Promise<void> {
  if (assigneeId === undefined || assigneeId === null) return;
  const membership = await prisma.teamMembership.findUnique({
    where: { userId_teamId: { userId: assigneeId, teamId } },
    select: { userId: true },
  });
  if (!membership) {
    throw Errors.badRequest('Assignee is not a member of this team');
  }
}

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
    input: {
      title: string;
      done?: boolean;
      startDate?: string | null;
      endDate?: string | null;
      // v1.42: optional assignee at create time.
      assigneeId?: string | null;
    },
  ): Promise<SubtaskView> {
    await this.ensureTaskInChain(teamId, projectId, taskId);
    // v1.41: date range validation. Zod has already enforced this on the
    // body, but the service is also called from tests/seed/etc. — keep
    // the rule here as the canonical guard.
    const startDate = input.startDate ? new Date(input.startDate) : null;
    const endDate = input.endDate ? new Date(input.endDate) : null;
    assertDateRange(startDate, endDate);
    // v1.42: validate assignee is a team member when provided.
    await assertAssigneeInTeam(teamId, input.assigneeId);
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
        // v1.42: explicit assignee or null. Unlike technician, we do NOT
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
      technicianId?: string | null;
      // v1.42: assignee — undefined leaves, null clears, string sets.
      // Anyone with project access can change (unlike technician, which
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

    // v1.42: validate assignee on change (skip when undefined or null).
    if (input.assigneeId !== undefined) {
      await assertAssigneeInTeam(teamId, input.assigneeId);
    }

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

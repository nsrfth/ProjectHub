import { Prisma, type DependencyType, type TaskStatus } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { AppError, Errors } from '../lib/errors.js';
import { logActivity } from './activityLogger.js';
import { notifications } from './notificationsService.js';
import { WebhookService } from './webhookService.js';

// v1.29: task dependency edges. A row taskId → dependsOnId means
// "taskId is BLOCKED by dependsOnId". The service layer owns:
//   - cycle prevention (DFS reachability before insert)
//   - cross-tenant safety (both tasks must share the caller's teamId)
//   - self-loop rejection (no taskId === dependsOnId edges)
//   - the status guard (callable from tasksService.update via
//     assertStatusTransitionAllowed)
//   - the unblock notification fan-out when a task transitions to DONE
//
// The route layer wraps every write with the `task.manage_dependencies`
// permission gate; reads are open to any team member.

// Webhook event names — same naming pattern as `task.created` / `task.updated`.
const EVENT_ADDED = 'task.dependency_added';
const EVENT_REMOVED = 'task.dependency_removed';

const _webhooks = new WebhookService();

const OPEN_STATUSES: ReadonlySet<TaskStatus> = new Set(['TODO', 'IN_PROGRESS', 'REVIEW']);

// Setting values for tasks.dependencyEnforcement. Mirrors v1.18's
// tasks.dateEditRestriction pattern: an InstanceSetting key with a constrained
// enum of string values. Default = off, so the feature is opt-in per instance.
export type DependencyEnforcement = 'off' | 'warn' | 'block';
const ENFORCEMENT_KEY = 'tasks.dependencyEnforcement';

export async function readDependencyEnforcement(): Promise<DependencyEnforcement> {
  try {
    const row = await prisma.instanceSetting.findUnique({ where: { key: ENFORCEMENT_KEY } });
    const raw = row?.value;
    if (raw === 'warn' || raw === 'block') return raw;
    return 'off';
  } catch {
    return 'off';
  }
}

// One side of the GET / response. The other task on the edge is joined in.
export interface DependencyEdgeView {
  id: string;
  type: DependencyType;
  createdAt: Date;
  // The OTHER task on the edge — for `blockedBy` it's the blocker; for
  // `blocking` it's the dependent. Always the task the UI wants to render
  // a link to.
  task: { id: string; title: string; status: TaskStatus; projectId: string };
}

export interface DependencyListView {
  blockedBy: DependencyEdgeView[];
  blocking: DependencyEdgeView[];
  enforcement: DependencyEnforcement;
}

const EDGE_SELECT = {
  id: true,
  type: true,
  createdAt: true,
  taskId: true,
  dependsOnId: true,
} as const;

function edgeView(
  row: { id: string; type: DependencyType; createdAt: Date },
  task: { id: string; title: string; status: TaskStatus; projectId: string },
): DependencyEdgeView {
  return { id: row.id, type: row.type, createdAt: row.createdAt, task };
}

export class DependenciesService {
  // Reads BOTH directions in a single round-trip so the UI can render
  // "Blocked by" + "Blocking" side-by-side.
  async list(teamId: string, taskId: string): Promise<DependencyListView> {
    const [blockedBy, blocking, enforcement] = await Promise.all([
      prisma.taskDependency.findMany({
        where: { teamId, taskId },
        select: {
          ...EDGE_SELECT,
          dependsOn: { select: { id: true, title: true, status: true, projectId: true } },
        },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.taskDependency.findMany({
        where: { teamId, dependsOnId: taskId },
        select: {
          ...EDGE_SELECT,
          task: { select: { id: true, title: true, status: true, projectId: true } },
        },
        orderBy: { createdAt: 'asc' },
      }),
      readDependencyEnforcement(),
    ]);

    return {
      blockedBy: blockedBy.map((r) => edgeView(r, r.dependsOn)),
      blocking: blocking.map((r) => edgeView(r, r.task)),
      enforcement,
    };
  }

  // Insert one edge taskId → dependsOnId. Throws:
  //   400 BAD_REQUEST       on self-loop
  //   403 FORBIDDEN         on cross-team mismatch
  //   404 NOT_FOUND         on either endpoint missing / not-in-team
  //   409 DEPENDENCY_CYCLE  if the edge would create a cycle
  //   409 CONFLICT          if the edge already exists (idempotent caller
  //                         can choose to swallow this)
  async add(args: {
    teamId: string;
    projectId: string; // the BLOCKED task's project — must match
    taskId: string;
    dependsOnId: string;
    type: DependencyType;
    actorId: string;
  }): Promise<DependencyEdgeView> {
    if (args.taskId === args.dependsOnId) {
      throw Errors.badRequest('A task cannot depend on itself');
    }

    // Load both endpoints under one tenant scope. Either being null means
    // "the caller's teamId doesn't own that task" — 404 to keep cross-
    // tenant probes opaque.
    // Both endpoints scoped by teamId at the query layer so a cross-team
    // probe surfaces as 404 (opaque) rather than 403 (which would confirm
    // that a task with that id exists in some other tenant).
    const [task, dep] = await Promise.all([
      prisma.task.findFirst({
        where: { id: args.taskId, teamId: args.teamId, projectId: args.projectId },
        select: { id: true, teamId: true, projectId: true, status: true, title: true },
      }),
      prisma.task.findFirst({
        where: { id: args.dependsOnId, teamId: args.teamId },
        select: { id: true, teamId: true, projectId: true, status: true, title: true },
      }),
    ]);
    if (!task) throw Errors.notFound('Task not found');
    if (!dep) throw Errors.notFound('Dependency target not found');
    // We also require both tasks to be in the SAME project. Cross-project
    // dependencies within a team are a niche case that complicates the
    // notification fan-out without obvious user value; revisit if asked.
    if (dep.projectId !== task.projectId) {
      throw Errors.badRequest('Dependency target is in a different project');
    }

    // Cycle check: walking forward from dependsOnId along the edge set,
    // does any path reach taskId? If yes, inserting this edge closes a
    // cycle. Iterative BFS over a Set so we stop the moment we see taskId.
    if (await this.wouldCreateCycle(args.teamId, args.taskId, args.dependsOnId)) {
      throw new AppError(409, 'DEPENDENCY_CYCLE', 'This dependency would create a cycle');
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        const created = await tx.taskDependency.create({
          data: {
            teamId: args.teamId,
            taskId: args.taskId,
            dependsOnId: args.dependsOnId,
            type: args.type,
          },
          select: {
            ...EDGE_SELECT,
            dependsOn: { select: { id: true, title: true, status: true, projectId: true } },
          },
        });
        await logActivity(tx, {
          taskId: args.taskId,
          teamId: args.teamId,
          actorId: args.actorId,
          action: 'task.dependency_added',
          meta: { dependsOnId: args.dependsOnId, type: args.type },
        });
        return created;
      });

      const view = edgeView(result, result.dependsOn);
      // Post-commit emit so a webhook subscriber reading the same row
      // doesn't race the transaction.
      await _webhooks.emit(args.teamId, EVENT_ADDED, {
        teamId: args.teamId,
        taskId: args.taskId,
        dependsOnId: args.dependsOnId,
        type: args.type,
        dependencyId: view.id,
      });
      return view;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Unique (taskId, dependsOnId) violated — edge already exists.
        throw Errors.conflict('Dependency already exists');
      }
      throw err;
    }
  }

  // Remove an edge by id, scoped to teamId so a forged id from another
  // team 404s.
  async remove(args: {
    teamId: string;
    dependencyId: string;
    actorId: string;
  }): Promise<void> {
    const existing = await prisma.taskDependency.findFirst({
      where: { id: args.dependencyId, teamId: args.teamId },
      select: { id: true, taskId: true, dependsOnId: true, type: true },
    });
    if (!existing) throw Errors.notFound('Dependency not found');

    await prisma.$transaction(async (tx) => {
      await tx.taskDependency.delete({ where: { id: existing.id } });
      await logActivity(tx, {
        taskId: existing.taskId,
        teamId: args.teamId,
        actorId: args.actorId,
        action: 'task.dependency_removed',
        meta: { dependsOnId: existing.dependsOnId, type: existing.type },
      });
    });

    await _webhooks.emit(args.teamId, EVENT_REMOVED, {
      teamId: args.teamId,
      taskId: existing.taskId,
      dependsOnId: existing.dependsOnId,
      type: existing.type,
      dependencyId: existing.id,
    });
  }

  // Status-guard helper called from tasksService.update. Returns silently
  // when the transition is allowed; throws 403 when enforcement=block and
  // there are incomplete FINISH_TO_START blockers. enforcement=warn never
  // throws here — the UI shows a soft warning before the request hits us.
  async assertStatusTransitionAllowed(
    taskId: string,
    nextStatus: TaskStatus,
  ): Promise<void> {
    // Only IN_PROGRESS / DONE transitions are gated. Moving BACK to TODO
    // or REVIEW from anywhere is always allowed.
    if (nextStatus !== 'IN_PROGRESS' && nextStatus !== 'DONE') return;
    const enforcement = await readDependencyEnforcement();
    if (enforcement !== 'block') return;
    const count = await this.countIncompleteBlockers(taskId);
    if (count > 0) {
      throw new AppError(
        403,
        'DEPENDENCY_BLOCKED',
        `Cannot move to ${nextStatus}: ${count} incomplete blocker${count === 1 ? '' : 's'}`,
      );
    }
  }

  // Count FINISH_TO_START edges OUT of taskId whose blocker is not DONE
  // and not soft-deleted. Used by the status guard + the unblock checker.
  async countIncompleteBlockers(taskId: string): Promise<number> {
    return prisma.taskDependency.count({
      where: {
        taskId,
        type: 'FINISH_TO_START',
        dependsOn: { status: { not: 'DONE' }, deletedAt: null },
      },
    });
  }

  // Bulk version for kanban list pages — one round-trip yields a map of
  // `{ taskId → incompleteBlockerCount }`. Tasks with zero blockers are
  // omitted from the map; callers should default missing keys to 0.
  async loadIncompleteBlockerCounts(taskIds: string[]): Promise<Map<string, number>> {
    if (taskIds.length === 0) return new Map();
    const rows = await prisma.taskDependency.findMany({
      where: {
        taskId: { in: taskIds },
        type: 'FINISH_TO_START',
        dependsOn: { status: { not: 'DONE' }, deletedAt: null },
      },
      select: { taskId: true },
    });
    const out = new Map<string, number>();
    for (const r of rows) out.set(r.taskId, (out.get(r.taskId) ?? 0) + 1);
    return out;
  }

  // Called from tasksService.update inside the same transaction that just
  // moved `doneTaskId` to DONE. Looks at every task that depended on it
  // and, for any whose remaining incomplete-blocker count is now zero,
  // writes a TASK_UNBLOCKED notification to its assignee + technician.
  async notifyUnblocked(
    tx: Prisma.TransactionClient,
    doneTaskId: string,
    actorId: string,
  ): Promise<void> {
    // All tasks that listed `doneTaskId` as a FINISH_TO_START blocker.
    const dependents = await tx.taskDependency.findMany({
      where: { dependsOnId: doneTaskId, type: 'FINISH_TO_START' },
      select: {
        taskId: true,
        teamId: true,
        task: {
          select: {
            id: true,
            title: true,
            projectId: true,
            teamId: true,
            assigneeId: true,
            technicianId: true,
          },
        },
      },
    });
    if (dependents.length === 0) return;

    // For each dependent, count its remaining incomplete blockers AFTER
    // the current transition. Within this tx the donor task is already
    // DONE, so the count reflects post-commit state.
    for (const dep of dependents) {
      const remaining = await tx.taskDependency.count({
        where: {
          taskId: dep.taskId,
          type: 'FINISH_TO_START',
          dependsOn: { status: { not: 'DONE' }, deletedAt: null },
        },
      });
      if (remaining > 0) continue;
      // Notify the dependent's assignee + technician, exclude the actor.
      const recipients = [dep.task.assigneeId, dep.task.technicianId]
        .filter((id): id is string => !!id && id !== actorId)
        .filter((id, i, arr) => arr.indexOf(id) === i);
      if (recipients.length === 0) continue;
      try {
        await tx.notification.createMany({
          data: recipients.map((userId) => ({
            userId,
            teamId: dep.task.teamId,
            type: 'TASK_UNBLOCKED',
            payload: {
              taskId: dep.task.id,
              taskTitle: dep.task.title,
              projectId: dep.task.projectId,
              unblockedBy: doneTaskId,
            } as Prisma.InputJsonValue,
          })),
        });
      } catch {
        // Best-effort — notification failures must not roll back the
        // status transition that triggered them.
      }
    }
  }

  // BFS from `start` over the existing edge set. Returns true if `target`
  // is reachable. Used to detect cycles BEFORE insert:
  //   adding (taskId → dependsOnId) closes a cycle iff there's an existing
  //   path from dependsOnId back to taskId.
  //
  // Worst-case visits every edge in the team's dependency graph, which is
  // bounded by the project's task count and is tiny in practice. A
  // strictly cycle-free guarantee requires the check + the insert to be
  // serialised; in this single-instance deployment a concurrent insert is
  // unlikely enough that we don't bother with row-level locking. If two
  // edges race and BOTH would close a cycle, the second insert will
  // succeed and we'll have a 2-cycle. The fix is a periodic janitor;
  // tracked under the v1.30 phase boundary.
  async wouldCreateCycle(
    teamId: string,
    candidateTaskId: string,
    candidateDependsOnId: string,
  ): Promise<boolean> {
    if (candidateTaskId === candidateDependsOnId) return true;
    const visited = new Set<string>([candidateDependsOnId]);
    let frontier: string[] = [candidateDependsOnId];
    while (frontier.length > 0) {
      // One DB round per BFS layer — much cheaper than per-node for
      // graphs that aren't deep.
      const next = await prisma.taskDependency.findMany({
        where: { teamId, taskId: { in: frontier } },
        select: { dependsOnId: true },
      });
      const newFrontier: string[] = [];
      for (const row of next) {
        if (row.dependsOnId === candidateTaskId) return true;
        if (!visited.has(row.dependsOnId)) {
          visited.add(row.dependsOnId);
          newFrontier.push(row.dependsOnId);
        }
      }
      frontier = newFrontier;
    }
    return false;
  }
}

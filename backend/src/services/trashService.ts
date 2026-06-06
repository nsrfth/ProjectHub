import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';
import type { GlobalRole, TeamRole } from '@prisma/client';
import { userHasPermission } from '../middleware/requirePermission.js';

// v1.21: per-team trash for soft-deleted Tasks + Comments.
//
// Soft-delete model: tasksService.remove and commentsService.remove stamp
// `deletedAt = now()` instead of issuing a SQL DELETE. All read paths in
// those services filter `deletedAt IS NULL`, so the row is invisible to
// normal queries. This service is the only place that opts INTO seeing the
// deleted rows — for listing, restoring, or purging.
//
// Permissions:
//  - list:    any team member
//  - restore: any team member (you can always undo your own goof)
//  - purge:   gated by the instance-wide `trash.emptyAllowedRoles` setting
//             ("admin" by default; "manager" or "admin-and-manager" widen it)
//  - empty:   same gate as purge — bulk hard-delete every row in the team's trash

export type EmptyAllowedRoles = 'admin' | 'admin-and-manager';

async function readEmptyAllowedRoles(): Promise<EmptyAllowedRoles> {
  try {
    const row = await prisma.instanceSetting.findUnique({
      where: { key: 'trash.emptyAllowedRoles' },
    });
    if (row?.value === 'admin-and-manager') return 'admin-and-manager';
  } catch {
    /* fall through */
  }
  // Default: only global ADMINs can purge or empty. Conservative — losing
  // production data should require deliberate operator action.
  return 'admin';
}

// v1.21 + v1.23: trash.purge is gated by BOTH layers:
//  (1) the instance-wide `trash.emptyAllowedRoles` policy ("admin" by default
//      — only global admins; "admin-and-manager" — also team managers)
//  (2) the per-role `trash.purge` permission (default Manager only)
// Both must pass. Global ADMIN bypasses both.
async function assertCanPurge(
  setting: EmptyAllowedRoles,
  callerId: string,
  teamId: string,
  callerTeamRole: TeamRole,
  callerGlobalRole: GlobalRole,
): Promise<void> {
  if (callerGlobalRole === 'ADMIN') return;
  // Layer 1: the instance setting. When "admin", anyone non-admin is blocked
  // outright — the permission system can't widen this gate (by design;
  // operators rely on the instance-wide policy as the harder lock).
  if (setting === 'admin') {
    throw Errors.forbidden(
      'Only global ADMINs can permanently delete items from trash on this instance',
    );
  }
  // setting === 'admin-and-manager'. Layer 2: the per-role permission. Default
  // Manager role grants trash.purge; default Member does not. Custom roles
  // can opt in.
  if (
    callerTeamRole !== 'MANAGER' &&
    !(await userHasPermission(callerId, teamId, callerGlobalRole, 'trash.purge'))
  ) {
    throw Errors.forbidden('Missing permission: trash.purge');
  }
}

export interface TrashedTask {
  kind: 'task';
  id: string;
  title: string;
  projectId: string;
  deletedAt: Date;
  deletedById: string | null;
  deletedByName: string | null;
}

export interface TrashedComment {
  kind: 'comment';
  id: string;
  taskId: string;
  bodyExcerpt: string;
  deletedAt: Date;
  deletedById: string | null;
  deletedByName: string | null;
}

export interface TrashContents {
  tasks: TrashedTask[];
  comments: TrashedComment[];
  // Echo the active purge gate back to the UI so the SPA can grey out the
  // Empty / Purge buttons for the wrong role without trial-and-error.
  emptyAllowedRoles: EmptyAllowedRoles;
}

export class TrashService {
  // List every soft-deleted Task + Comment scoped to this team. Newest first
  // so recent mistakes are easy to undo.
  async list(teamId: string): Promise<TrashContents> {
    const [tasks, comments, setting] = await Promise.all([
      prisma.task.findMany({
        where: { teamId, deletedAt: { not: null } },
        orderBy: { deletedAt: 'desc' },
        include: { deletedBy: { select: { name: true } } },
      }),
      // Comments belong to a task, which is teamId-scoped — join through to
      // filter. Hits the comment's own (taskId, deletedAt) index by way of
      // the inner predicate.
      prisma.comment.findMany({
        where: { deletedAt: { not: null }, task: { teamId } },
        orderBy: { deletedAt: 'desc' },
        include: { deletedBy: { select: { name: true } } },
      }),
      readEmptyAllowedRoles(),
    ]);
    return {
      tasks: tasks.map((t) => ({
        kind: 'task' as const,
        id: t.id,
        title: t.title,
        projectId: t.projectId,
        deletedAt: t.deletedAt!,
        deletedById: t.deletedById,
        deletedByName: t.deletedBy?.name ?? null,
      })),
      comments: comments.map((c) => ({
        kind: 'comment' as const,
        id: c.id,
        taskId: c.taskId,
        bodyExcerpt: c.body.slice(0, 200),
        deletedAt: c.deletedAt!,
        deletedById: c.deletedById,
        deletedByName: c.deletedBy?.name ?? null,
      })),
      emptyAllowedRoles: setting,
    };
  }

  async restoreTask(teamId: string, taskId: string): Promise<void> {
    const t = await prisma.task.findUnique({ where: { id: taskId }, select: { teamId: true, deletedAt: true } });
    if (!t || t.teamId !== teamId || t.deletedAt === null) {
      throw Errors.notFound('Task not in trash');
    }
    await prisma.task.update({
      where: { id: taskId },
      data: { deletedAt: null, deletedById: null },
    });
  }

  async restoreComment(teamId: string, commentId: string): Promise<void> {
    const c = await prisma.comment.findUnique({
      where: { id: commentId },
      select: { deletedAt: true, task: { select: { teamId: true } } },
    });
    if (!c || c.task.teamId !== teamId || c.deletedAt === null) {
      throw Errors.notFound('Comment not in trash');
    }
    await prisma.comment.update({
      where: { id: commentId },
      data: { deletedAt: null, deletedById: null },
    });
  }

  async purgeTask(
    teamId: string,
    taskId: string,
    callerId: string,
    callerTeamRole: TeamRole,
    callerGlobalRole: GlobalRole,
  ): Promise<void> {
    const setting = await readEmptyAllowedRoles();
    await assertCanPurge(setting, callerId, teamId, callerTeamRole, callerGlobalRole);
    const t = await prisma.task.findUnique({ where: { id: taskId }, select: { teamId: true, deletedAt: true } });
    if (!t || t.teamId !== teamId || t.deletedAt === null) {
      throw Errors.notFound('Task not in trash');
    }
    await prisma.task.delete({ where: { id: taskId } });
  }

  async purgeComment(
    teamId: string,
    commentId: string,
    callerId: string,
    callerTeamRole: TeamRole,
    callerGlobalRole: GlobalRole,
  ): Promise<void> {
    const setting = await readEmptyAllowedRoles();
    await assertCanPurge(setting, callerId, teamId, callerTeamRole, callerGlobalRole);
    const c = await prisma.comment.findUnique({
      where: { id: commentId },
      select: { deletedAt: true, task: { select: { teamId: true } } },
    });
    if (!c || c.task.teamId !== teamId || c.deletedAt === null) {
      throw Errors.notFound('Comment not in trash');
    }
    await prisma.comment.delete({ where: { id: commentId } });
  }

  // Bulk hard-delete every soft-deleted Task + Comment in the team. Same gate
  // as purgeX. Returns the counts so the UI can show a "47 tasks + 12 comments
  // permanently deleted" confirmation.
  async empty(
    teamId: string,
    callerId: string,
    callerTeamRole: TeamRole,
    callerGlobalRole: GlobalRole,
  ): Promise<{ tasksPurged: number; commentsPurged: number }> {
    const setting = await readEmptyAllowedRoles();
    await assertCanPurge(setting, callerId, teamId, callerTeamRole, callerGlobalRole);

    // Wrap in a transaction so a mid-flight failure doesn't leave the trash
    // half-emptied. The deleteMany filters are the same as the list query.
    return prisma.$transaction(async (tx) => {
      const c = await tx.comment.deleteMany({
        where: { deletedAt: { not: null }, task: { teamId } },
      });
      const t = await tx.task.deleteMany({
        where: { teamId, deletedAt: { not: null } },
      });
      return { tasksPurged: t.count, commentsPurged: c.count };
    });
  }
}

import { Prisma, type TeamRole } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';
import { logActivity } from './activityLogger.js';
import { notifications } from './notificationsService.js';
import { WebhookService } from './webhookService.js';

// Webhook emitter — best-effort post-commit fan-out. Same pattern as
// tasksService: never inside the transaction.
const _webhooks = new WebhookService();

// Extract every distinct `@handle` from a comment body. The handle is the
// local-part of a team member's email (e.g. `@alice` matches `alice@x.com`).
// A real handle field on User would be cleaner — but the email local-part
// works as a stand-in and avoids a schema migration here.
function extractMentions(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(/@([a-zA-Z0-9._-]+)/g)) {
    const handle = m[1];
    if (handle) out.add(handle.toLowerCase());
  }
  return [...out];
}

// Same shape Prisma passes into a $transaction callback. Importing the
// internal type directly avoids the "Parameters<Parameters<…>>[0]" dance
// (which TypeScript widens to `T | undefined` under strict array indexing).
type TxClient = Prisma.TransactionClient;

// Resolve `@handles` against a team's members. Returns the userIds of every
// team member whose email local-part exactly matches one of the handles.
// Two users in the same team with the same local-part both get notified —
// rare edge case, easier than disambiguating.
async function resolveMentionsToUserIds(
  client: TxClient,
  teamId: string,
  handles: string[],
): Promise<string[]> {
  if (handles.length === 0) return [];
  const memberships = await client.teamMembership.findMany({
    where: { teamId },
    include: { user: { select: { id: true, email: true } } },
  });
  const set = new Set<string>();
  for (const m of memberships) {
    const local = (m.user.email.split('@')[0] ?? '').toLowerCase();
    if (local && handles.includes(local)) set.add(m.user.id);
  }
  return [...set];
}

export interface CommentView {
  id: string;
  taskId: string;
  // authorId / authorName become null when the author has been deleted by an
  // admin (FK SetNull). The comment body itself is preserved.
  authorId: string | null;
  authorName: string | null;
  body: string;
  createdAt: Date;
  updatedAt: Date;
}

export class CommentsService {
  // The task's parent chain (team→project→task) is validated by the route layer
  // before this service is called, so we only need to verify that the comment,
  // when fetched, actually belongs to the task in question.

  async create(taskId: string, authorId: string, body: string): Promise<CommentView> {
    // Run the comment insert and the activity log in one transaction so an
    // audit row appears iff the comment is persisted.
    return prisma.$transaction(async (tx) => {
      const c = await tx.comment.create({
        data: { taskId, authorId, body },
        include: {
          author: { select: { name: true } },
          task: { select: { title: true, teamId: true, projectId: true } },
        },
      });
      await logActivity(tx, {
        taskId,
        actorId: authorId,
        action: 'comment.added',
        meta: { commentId: c.id, excerpt: body.slice(0, 120) },
      });
      await notifications.onCommentAdded(tx, {
        taskId,
        projectId: c.task.projectId,
        teamId: c.task.teamId,
        actorId: authorId,
        commentId: c.id,
        excerpt: body.slice(0, 120),
        taskTitle: c.task.title,
      });
      // @mention fan-out — independent of the TASK_COMMENT notification so a
      // mentioned user who is also the assignee gets two distinct rows. Two
      // notifications is the more useful UX (badge counts the events, not the
      // commits) and matches expectations from other tools.
      const handles = extractMentions(body);
      if (handles.length > 0) {
        const mentionedUserIds = await resolveMentionsToUserIds(tx, c.task.teamId, handles);
        if (mentionedUserIds.length > 0) {
          await notifications.onMention(tx, {
            taskId,
            projectId: c.task.projectId,
            teamId: c.task.teamId,
            actorId: authorId,
            commentId: c.id,
            excerpt: body.slice(0, 120),
            taskTitle: c.task.title,
            recipients: mentionedUserIds,
          });
        }
      }
      return {
        view: {
          id: c.id,
          taskId: c.taskId,
          authorId: c.authorId,
          authorName: c.author?.name ?? null,
          body: c.body,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
        },
        teamId: c.task.teamId,
        taskTitle: c.task.title,
      };
    }).then(async ({ view, teamId, taskTitle }) => {
      // Post-commit emit. Subscribers get the comment + its task context so
      // they don't need to re-resolve the task themselves. Awaited so the
      // delivery row exists by the time the API response returns.
      await _webhooks.emit(teamId, 'comment.added', {
        comment: view, taskId: view.taskId, taskTitle, teamId,
      });
      return view;
    });
  }

  async list(taskId: string): Promise<CommentView[]> {
    const rows = await prisma.comment.findMany({
      where: { taskId },
      orderBy: { createdAt: 'asc' },
      include: { author: { select: { name: true } } },
    });
    return rows.map((c) => ({
      id: c.id,
      taskId: c.taskId,
      authorId: c.authorId,
      authorName: c.author?.name ?? null,
      body: c.body,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    }));
  }

  async update(
    taskId: string,
    commentId: string,
    callerId: string,
    body: string,
  ): Promise<CommentView> {
    const existing = await prisma.comment.findUnique({ where: { id: commentId } });
    if (!existing || existing.taskId !== taskId) throw Errors.notFound('Comment not found');
    if (existing.authorId !== callerId) {
      // Editing someone else's words is never OK — even a MANAGER can only delete.
      throw Errors.forbidden('Only the author can edit a comment');
    }

    return prisma.$transaction(async (tx) => {
      const c = await tx.comment.update({
        where: { id: commentId },
        data: { body },
        include: { author: { select: { name: true } } },
      });
      await logActivity(tx, {
        taskId,
        actorId: callerId,
        action: 'comment.edited',
        meta: { commentId: c.id, excerpt: body.slice(0, 120) },
      });
      return {
        id: c.id,
        taskId: c.taskId,
        authorId: c.authorId,
        authorName: c.author?.name ?? null,
        body: c.body,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      };
    });
  }

  async remove(
    taskId: string,
    commentId: string,
    callerId: string,
    callerRole: TeamRole,
  ): Promise<void> {
    const existing = await prisma.comment.findUnique({ where: { id: commentId } });
    if (!existing || existing.taskId !== taskId) throw Errors.notFound('Comment not found');
    if (existing.authorId !== callerId && callerRole !== 'MANAGER') {
      throw Errors.forbidden('Only the author or a team MANAGER can delete this comment');
    }

    await prisma.$transaction(async (tx) => {
      try {
        await tx.comment.delete({ where: { id: commentId } });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
          throw Errors.notFound('Comment not found');
        }
        throw err;
      }
      await logActivity(tx, {
        taskId,
        actorId: callerId,
        action: 'comment.deleted',
        meta: { commentId },
      });
    });
  }
}

import { Prisma, type TeamRole } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';
import { logActivity } from './activityLogger.js';
import { notifications } from './notificationsService.js';

export interface CommentView {
  id: string;
  taskId: string;
  authorId: string;
  authorName: string;
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
        include: { author: { select: { name: true } }, task: { select: { title: true, teamId: true } } },
      });
      await logActivity(tx, {
        taskId,
        actorId: authorId,
        action: 'comment.added',
        meta: { commentId: c.id, excerpt: body.slice(0, 120) },
      });
      await notifications.onCommentAdded(tx, {
        taskId,
        teamId: c.task.teamId,
        actorId: authorId,
        commentId: c.id,
        excerpt: body.slice(0, 120),
        taskTitle: c.task.title,
      });
      return {
        id: c.id,
        taskId: c.taskId,
        authorId: c.authorId,
        authorName: c.author.name,
        body: c.body,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      };
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
      authorName: c.author.name,
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
        authorName: c.author.name,
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

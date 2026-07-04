import type { Prisma, NotifyType } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';
import { notificationsHub } from './notificationsHub.js';

// One service handles both the read-side (list, count, mark-read) and the
// write-side (fan-out helpers called from tasks/comments services).
//
// Fan-out helpers accept a Prisma transaction client so notification rows
// commit atomically with the mutation that triggered them — a comment without
// its notification (or vice versa) would be a confusing UX.

type Client = Prisma.TransactionClient | typeof prisma;

interface RecipientContext {
  taskId: string;
  // projectId is in every payload so the frontend bell can deep-link to the
  // task detail page (`/projects/:projectId/tasks/:taskId`) without an
  // extra lookup round-trip.
  projectId: string;
  teamId: string;
  actorId: string; // never notify the user who caused the event
}

async function loadTaskRecipients(
  client: Client,
  taskId: string,
  actorId: string,
): Promise<string[]> {
  const task = await client.task.findUnique({
    where: { id: taskId },
    select: { assigneeId: true, creatorId: true },
  });
  if (!task) return [];
  // Deduplicated, actor excluded.
  return [task.assigneeId, task.creatorId]
    .filter((id): id is string => !!id && id !== actorId)
    .filter((id, i, arr) => arr.indexOf(id) === i);
}

async function insertMany(
  client: Client,
  type: NotifyType,
  ctx: RecipientContext,
  recipients: string[],
  payload: Prisma.InputJsonValue,
): Promise<void> {
  if (recipients.length === 0) return;
  try {
    await client.notification.createMany({
      data: recipients.map((userId) => ({
        userId,
        teamId: ctx.teamId,
        type,
        payload,
      })),
    });
    // Wake up any open WebSockets. Best-effort: hub.publish is a no-op when
    // the user has no live socket, so this incurs no cost for offline users.
    // The event is a tiny ping ("something new arrived"); clients re-fetch
    // via the normal REST endpoint so we don't have to wire WS into the cache.
    for (const userId of recipients) {
      notificationsHub.publish(userId, { type: 'notification:new', id: '' });
    }
  } catch {
    // Best-effort fan-out. Failures shouldn't fail the parent mutation.
  }
}

export const notifications = {
  async onTaskAssigned(
    client: Client,
    ctx: RecipientContext & { newAssigneeId: string; taskTitle: string },
  ): Promise<void> {
    // Only the new assignee is notified for assignment. Don't notify if the
    // assignee is the actor (they assigned themselves).
    if (ctx.newAssigneeId === ctx.actorId) return;
    await insertMany(client, 'TASK_ASSIGNED', ctx, [ctx.newAssigneeId], {
      taskId: ctx.taskId,
      projectId: ctx.projectId,
      taskTitle: ctx.taskTitle,
      assignedBy: ctx.actorId,
    });
  },

  async onCommentAdded(
    client: Client,
    ctx: RecipientContext & { commentId: string; excerpt: string; taskTitle: string },
  ): Promise<void> {
    const recipients = await loadTaskRecipients(client, ctx.taskId, ctx.actorId);
    await insertMany(client, 'TASK_COMMENT', ctx, recipients, {
      taskId: ctx.taskId,
      projectId: ctx.projectId,
      taskTitle: ctx.taskTitle,
      commentId: ctx.commentId,
      excerpt: ctx.excerpt,
      commenterId: ctx.actorId,
    });
  },

  async onStatusChanged(
    client: Client,
    ctx: RecipientContext & { from: string; to: string; taskTitle: string },
  ): Promise<void> {
    const recipients = await loadTaskRecipients(client, ctx.taskId, ctx.actorId);
    await insertMany(client, 'TASK_STATUS', ctx, recipients, {
      taskId: ctx.taskId,
      projectId: ctx.projectId,
      taskTitle: ctx.taskTitle,
      from: ctx.from,
      to: ctx.to,
      changedBy: ctx.actorId,
    });
  },

  async onMention(
    client: Client,
    ctx: RecipientContext & {
      commentId: string;
      excerpt: string;
      taskTitle: string;
      recipients: string[];
    },
  ): Promise<void> {
    // Pre-filter actor + dedupe so onMention itself stays a thin wrapper.
    const recipients = [...new Set(ctx.recipients)].filter((id) => id !== ctx.actorId);
    await insertMany(client, 'MENTION', ctx, recipients, {
      taskId: ctx.taskId,
      projectId: ctx.projectId,
      taskTitle: ctx.taskTitle,
      commentId: ctx.commentId,
      excerpt: ctx.excerpt,
      mentionedBy: ctx.actorId,
    });
  },

  // v1.90: a project letter (correspondence) was referred (ارجاع) to one or
  // more team members for ACTION or INFO. One notification row per recipient
  // (actor excluded). Mirrors the in-transaction createMany + hub.publish
  // pattern of the task notifications; the payload carries the reference
  // number + subject so the bell can render without a follow-up fetch.
  async onCorrespondenceReferral(
    client: Client,
    ctx: {
      teamId: string;
      projectId: string;
      correspondenceId: string;
      referenceNumber: string;
      subject: string;
      actorId: string;
      recipients: Array<{ userId: string; kind: 'ACTION' | 'INFO' }>;
    },
  ): Promise<void> {
    const targets = ctx.recipients.filter((r) => r.userId !== ctx.actorId);
    if (targets.length === 0) return;
    try {
      await client.notification.createMany({
        data: targets.map((r) => ({
          userId: r.userId,
          teamId: ctx.teamId,
          type: 'CORRESPONDENCE_REFERRAL' as NotifyType,
          payload: {
            correspondenceId: ctx.correspondenceId,
            projectId: ctx.projectId,
            referenceNumber: ctx.referenceNumber,
            subject: ctx.subject,
            kind: r.kind,
            referredBy: ctx.actorId,
          },
        })),
      });
      for (const r of targets) {
        notificationsHub.publish(r.userId, { type: 'notification:new', id: '' });
      }
    } catch {
      // Best-effort fan-out. Failures shouldn't fail the parent mutation.
    }
  },

  async onTaskDue(
    client: Client,
    ctx: { taskId: string; projectId: string; teamId: string; taskTitle: string; dueDate: string },
  ): Promise<void> {
    // Notify the assignee + creator. Used by the scheduler; the "actor" here
    // is effectively the system, so we don't exclude anyone.
    const task = await client.task.findUnique({
      where: { id: ctx.taskId },
      select: { assigneeId: true, creatorId: true },
    });
    if (!task) return;
    const recipients = [task.assigneeId, task.creatorId]
      .filter((id): id is string => !!id)
      .filter((id, i, arr) => arr.indexOf(id) === i);
    await insertMany(
      client,
      'TASK_DUE',
      { taskId: ctx.taskId, projectId: ctx.projectId, teamId: ctx.teamId, actorId: '' },
      recipients,
      {
        taskId: ctx.taskId,
        projectId: ctx.projectId,
        taskTitle: ctx.taskTitle,
        dueDate: ctx.dueDate,
      },
    );
  },

  // v2.5.28: a personal (standalone) task is coming due. Owner-only, team-less
  // notification (teamId null). Best-effort — never fails the caller.
  async onStandaloneTaskDue(
    client: Client,
    ctx: { standaloneTaskId: string; ownerId: string; title: string; dueDate: string },
  ): Promise<void> {
    try {
      await client.notification.create({
        data: {
          userId: ctx.ownerId,
          teamId: null,
          type: 'STANDALONE_TASK_DUE' as NotifyType,
          payload: {
            standaloneTaskId: ctx.standaloneTaskId,
            taskTitle: ctx.title,
            dueDate: ctx.dueDate,
          },
        },
      });
      notificationsHub.publish(ctx.ownerId, { type: 'notification:new', id: '' });
    } catch {
      // Best-effort fan-out.
    }
  },
};

export class NotificationsService {
  async list(userId: string, opts: { unreadOnly?: boolean; limit?: number }) {
    return prisma.notification.findMany({
      where: { userId, ...(opts.unreadOnly && { readAt: null }) },
      orderBy: { createdAt: 'desc' },
      take: opts.limit ?? 50,
    });
  }

  async unreadCount(userId: string): Promise<number> {
    return prisma.notification.count({ where: { userId, readAt: null } });
  }

  async markRead(userId: string, notificationId: string): Promise<void> {
    // updateMany scoped to (id, userId) so a user can't mark someone else's
    // notification read by guessing an id.
    const r = await prisma.notification.updateMany({
      where: { id: notificationId, userId, readAt: null },
      data: { readAt: new Date() },
    });
    if (r.count === 0) {
      // Either the id doesn't exist, isn't yours, or it was already read.
      // We don't distinguish — preserves privacy and is idempotent enough.
      const exists = await prisma.notification.findFirst({
        where: { id: notificationId, userId },
        select: { id: true },
      });
      if (!exists) throw Errors.notFound('Notification not found');
    }
  }

  async markAllRead(userId: string): Promise<void> {
    await prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
  }
}

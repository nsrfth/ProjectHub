import type { FastifyReply, FastifyRequest } from 'fastify';
import type { NotificationsService } from '../services/notificationsService.js';
import type { ListNotificationsQuery } from '../schemas/notifications.js';
import { Errors } from '../lib/errors.js';

type NotificationParams = { notificationId: string };

export class NotificationsController {
  constructor(private readonly svc: NotificationsService) {}

  list = async (
    req: FastifyRequest<{ Querystring: ListNotificationsQuery }>,
    reply: FastifyReply,
  ) => {
    if (!req.user) throw Errors.unauthorized();
    const rows = await this.svc.list(req.user.sub, {
      unreadOnly: req.query.unreadOnly,
      limit: req.query.limit,
    });
    return reply.send(
      rows.map((n) => ({
        id: n.id,
        userId: n.userId,
        teamId: n.teamId,
        type: n.type,
        payload: n.payload,
        readAt: n.readAt ? n.readAt.toISOString() : null,
        createdAt: n.createdAt.toISOString(),
      })),
    );
  };

  unreadCount = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) throw Errors.unauthorized();
    const count = await this.svc.unreadCount(req.user.sub);
    return reply.send({ count });
  };

  markRead = async (
    req: FastifyRequest<{ Params: NotificationParams }>,
    reply: FastifyReply,
  ) => {
    if (!req.user) throw Errors.unauthorized();
    await this.svc.markRead(req.user.sub, req.params.notificationId);
    return reply.status(204).send();
  };

  markAllRead = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) throw Errors.unauthorized();
    await this.svc.markAllRead(req.user.sub);
    return reply.status(204).send();
  };
}

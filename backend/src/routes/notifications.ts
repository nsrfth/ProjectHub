import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { NotificationsService } from '../services/notificationsService.js';
import { NotificationsController } from '../controllers/notificationsController.js';
import { requireAuth } from '../middleware/auth.js';
import {
  listNotificationsQuery,
  notificationResponse,
  unreadCountResponse,
} from '../schemas/notifications.js';

// Notifications are user-scoped (not team-scoped), so there's no requireTeamRole
// gate. Each query is implicitly filtered to the caller's userId.
export async function notificationsRoutes(app: FastifyInstance): Promise<void> {
  const svc = new NotificationsService();
  const ctrl = new NotificationsController(svc);
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);

  r.get('/', {
    schema: {
      tags: ['notifications'],
      summary: 'List my notifications (newest first, optionally unread-only)',
      querystring: listNotificationsQuery,
      response: { 200: z.array(notificationResponse) },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.list,
  });

  r.get('/unread-count', {
    schema: {
      tags: ['notifications'],
      summary: 'Get my unread notification count (cheap, for the bell badge)',
      response: { 200: unreadCountResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.unreadCount,
  });

  r.post('/:notificationId/read', {
    schema: {
      tags: ['notifications'],
      summary: 'Mark one notification as read',
      params: z.object({ notificationId: z.string() }),
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.markRead,
  });

  r.post('/read-all', {
    schema: {
      tags: ['notifications'],
      summary: 'Mark every unread notification as read',
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.markAllRead,
  });
}

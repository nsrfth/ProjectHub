import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { WebhookService } from '../services/webhookService.js';
import { WebhooksController } from '../controllers/webhooksController.js';
import { requireAuth, requireTeamRole } from '../middleware/auth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { requireScope } from '../middleware/requireScope.js';
import {
  webhookCreateBody,
  webhookCreatedResponse,
  webhookDeliveryListResponse,
  webhookDeliveryQuery,
  webhookIdParams,
  webhookListResponse,
  webhookResponse,
  webhookTestResponse,
  webhookUpdateBody,
} from '../schemas/webhooks.js';

// Webhook CRUD. Mounted at /api/teams/:teamId/webhooks; requires MANAGER on
// the team (admins join via the same role check since admin-of-the-team
// implies MANAGER membership for the operations that matter).
export async function webhooksRoutes(app: FastifyInstance): Promise<void> {
  const svc = new WebhookService();
  const ctrl = new WebhooksController(svc);
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  // v1.23: webhook management is gated by the `webhooks.manage` permission
  // rather than the legacy MANAGER role check. requireTeamRole still runs
  // so the membership is stashed on the request for the permission lookup.
  r.addHook('preHandler', requireTeamRole('MEMBER', 'MANAGER'));
  r.addHook('preHandler', requirePermission('webhooks.manage'));
  // v1.30.3 (S-2): API tokens must carry the webhooks:manage scope. The
  // permission system gates the human user; the scope gate restricts a
  // narrow-scope API token from touching this surface even when the
  // owning user has the permission.
  r.addHook('preHandler', requireScope('webhooks:manage'));

  r.get('/', {
    schema: {
      tags: ['webhooks'],
      summary: 'List webhooks for this team',
      params: z.object({ teamId: z.string() }),
      response: { 200: webhookListResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.list,
  });

  r.post('/', {
    schema: {
      tags: ['webhooks'],
      summary: 'Create a webhook. Raw signing secret returned ONCE.',
      params: z.object({ teamId: z.string() }),
      body: webhookCreateBody,
      response: { 201: webhookCreatedResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.create,
  });

  r.patch('/:webhookId', {
    schema: {
      tags: ['webhooks'],
      summary: 'Update a webhook',
      params: webhookIdParams,
      body: webhookUpdateBody,
      response: { 200: webhookResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.update,
  });

  r.delete('/:webhookId', {
    schema: {
      tags: ['webhooks'],
      summary: 'Delete a webhook',
      params: webhookIdParams,
      response: { 204: z.null() },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.remove,
  });

  r.post('/:webhookId/test', {
    schema: {
      tags: ['webhooks'],
      summary: 'Synchronously fire a test delivery; returns the outcome',
      params: webhookIdParams,
      response: { 200: webhookTestResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.testSend,
  });

  r.get('/:webhookId/deliveries', {
    schema: {
      tags: ['webhooks'],
      summary: 'Recent delivery attempts (newest first)',
      params: webhookIdParams,
      querystring: webhookDeliveryQuery,
      response: { 200: webhookDeliveryListResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.listDeliveries,
  });
}

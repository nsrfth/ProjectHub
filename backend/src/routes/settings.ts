import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { InstanceSettingsService } from '../services/instanceSettingsService.js';
import { SettingsController } from '../controllers/settingsController.js';
import { requireAuth, requireGlobalAdmin } from '../middleware/auth.js';
import {
  instanceSettingKeyParams,
  instanceSettingResponse,
  instanceSettingUpsertBody,
  instanceSettingsListResponse,
} from '../schemas/settings.js';

// Instance-scoped settings. Mounted at /api/settings/instance.
// All endpoints require GlobalRole.ADMIN — Phase 1 ships only the instance
// surface; per-team and per-user settings can land alongside under
// /api/settings/teams/:teamId and /api/settings/me when needed.
export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  const svc = new InstanceSettingsService();
  const ctrl = new SettingsController(svc);
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireGlobalAdmin);

  r.get('/instance', {
    schema: {
      tags: ['settings'],
      summary: 'List all instance settings',
      response: { 200: instanceSettingsListResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.listInstance,
  });

  r.get('/instance/:key', {
    schema: {
      tags: ['settings'],
      summary: 'Read a single instance setting by key',
      params: instanceSettingKeyParams,
      response: { 200: instanceSettingResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.getInstance,
  });

  r.put('/instance/:key', {
    schema: {
      tags: ['settings'],
      summary: 'Create or overwrite an instance setting',
      params: instanceSettingKeyParams,
      body: instanceSettingUpsertBody,
      response: { 200: instanceSettingResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.upsertInstance,
  });

  r.delete('/instance/:key', {
    schema: {
      tags: ['settings'],
      summary: 'Delete an instance setting',
      params: instanceSettingKeyParams,
      response: { 204: z.null() },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.deleteInstance,
  });
}

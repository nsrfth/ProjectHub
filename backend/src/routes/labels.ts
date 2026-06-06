import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { LabelsService } from '../services/labelsService.js';
import { LabelsController } from '../controllers/labelsController.js';
import { requireAuth, requireTeamRole } from '../middleware/auth.js';
import { requireScope } from '../middleware/requireScope.js';
import { createLabelBody, labelResponse, updateLabelBody } from '../schemas/labels.js';

// Team-scoped label CRUD. Attach/detach against a specific task live on a
// separate route file (taskLabelsRoutes) because they need the project+task
// segments in the URL.
export async function labelsRoutes(app: FastifyInstance): Promise<void> {
  const svc = new LabelsService();
  const ctrl = new LabelsController(svc);
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireTeamRole('MEMBER', 'MANAGER'));

  r.get('/', {
    preHandler: requireScope('projects:read'),
    schema: {
      tags: ['labels'],
      summary: 'List labels for this team',
      params: z.object({ teamId: z.string() }),
      response: { 200: z.array(labelResponse) },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.list,
  });

  r.post('/', {
    preHandler: requireScope('projects:write'),
    schema: {
      tags: ['labels'],
      summary: 'Create a label (name must be unique within the team)',
      params: z.object({ teamId: z.string() }),
      body: createLabelBody,
      response: { 201: labelResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.create,
  });

  r.patch('/:labelId', {
    preHandler: requireScope('projects:write'),
    schema: {
      tags: ['labels'],
      summary: 'Update a label name/color',
      params: z.object({ teamId: z.string(), labelId: z.string() }),
      body: updateLabelBody,
      response: { 200: labelResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.update,
  });

  r.delete('/:labelId', {
    preHandler: requireScope('projects:write'),
    schema: {
      tags: ['labels'],
      summary: 'Delete a label (cascade-detaches it from every task)',
      params: z.object({ teamId: z.string(), labelId: z.string() }),
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.remove,
  });
}

// Attach/detach routes. Mounted under /teams/:teamId/projects/:projectId/tasks/:taskId/labels
// so :teamId is in the URL for requireTeamRole and the path is self-describing.
export async function taskLabelsRoutes(app: FastifyInstance): Promise<void> {
  const svc = new LabelsService();
  const ctrl = new LabelsController(svc);
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireTeamRole('MEMBER', 'MANAGER'));

  r.post('/', {
    preHandler: requireScope('tasks:write'),
    schema: {
      tags: ['labels'],
      summary: 'Attach a label to this task (idempotent)',
      params: z.object({ teamId: z.string(), projectId: z.string(), taskId: z.string() }),
      body: z.object({ labelId: z.string() }),
      response: { 201: labelResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.attach,
  });

  r.delete('/:labelId', {
    preHandler: requireScope('tasks:write'),
    schema: {
      tags: ['labels'],
      summary: 'Detach a label from this task (no-op if not attached)',
      params: z.object({
        teamId: z.string(),
        projectId: z.string(),
        taskId: z.string(),
        labelId: z.string(),
      }),
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.detach,
  });
}

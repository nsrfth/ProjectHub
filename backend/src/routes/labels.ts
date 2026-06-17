import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { LabelsService } from '../services/labelsService.js';
import { LabelsController } from '../controllers/labelsController.js';
import {
  requireAuth,
  requireGlobalRole,
  requireTeamRole,
  requireTeamRoleOrGrantedProject,
} from '../middleware/auth.js';
import { requireProjectAccess, requireProjectWriteAccess } from '../middleware/requireProjectAccess.js';
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

// v1.80: global "predefined" labels — admin-managed, visible and usable in
// every team. Mounted at /admin/labels so it shares the GlobalRole=ADMIN gate
// (no team scope: these are instance-wide). Members consume them via the
// team catalog (GET /teams/:teamId/labels, which now includes globals).
export async function globalLabelsRoutes(app: FastifyInstance): Promise<void> {
  const svc = new LabelsService();
  const ctrl = new LabelsController(svc);
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireGlobalRole('ADMIN'));

  r.get('/', {
    schema: {
      tags: ['labels'],
      summary: 'List global predefined labels',
      response: { 200: z.array(labelResponse) },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.listGlobal,
  });

  r.post('/', {
    schema: {
      tags: ['labels'],
      summary: 'Create a global predefined label (unique name across all globals)',
      body: createLabelBody,
      response: { 201: labelResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.createGlobal,
  });

  r.patch('/:labelId', {
    schema: {
      tags: ['labels'],
      summary: 'Update a global predefined label name/color',
      params: z.object({ labelId: z.string() }),
      body: updateLabelBody,
      response: { 200: labelResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.updateGlobal,
  });

  r.delete('/:labelId', {
    schema: {
      tags: ['labels'],
      summary: 'Delete a global predefined label (detaches it everywhere)',
      params: z.object({ labelId: z.string() }),
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.removeGlobal,
  });
}

// Attach/detach routes. Mounted under /teams/:teamId/projects/:projectId/tasks/:taskId/labels
// so :teamId is in the URL for requireTeamRole and the path is self-describing.
export async function taskLabelsRoutes(app: FastifyInstance): Promise<void> {
  const svc = new LabelsService();
  const ctrl = new LabelsController(svc);
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireTeamRoleOrGrantedProject('MEMBER', 'MANAGER'));
  // v1.39: project visibility cascade. (labelsRoutes above is team-scoped
  // and intentionally skipped — labels are team-wide vocabulary.)
  r.addHook('preHandler', requireProjectAccess());

  r.post('/', {
    preHandler: [requireProjectWriteAccess(), requireScope('tasks:write')],
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
    preHandler: [requireProjectWriteAccess(), requireScope('tasks:write')],
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

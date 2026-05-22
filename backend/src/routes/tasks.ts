import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { TasksService } from '../services/tasksService.js';
import { TasksController } from '../controllers/tasksController.js';
import { requireAuth, requireTeamRole } from '../middleware/auth.js';
import {
  createTaskBody,
  listTasksQuery,
  taskResponse,
  updateTaskBody,
} from '../schemas/tasks.js';

// Tasks live at /api/teams/:teamId/projects/:projectId/tasks so requireTeamRole
// can resolve :teamId. The service enforces the project↔team and task↔project
// parent chains; any mismatch returns 404 (never leaks cross-tenant existence).
export async function tasksRoutes(app: FastifyInstance): Promise<void> {
  const svc = new TasksService();
  const ctrl = new TasksController(svc);
  const r = app.withTypeProvider<ZodTypeProvider>();

  // Any team member (MEMBER or MANAGER) can create/read/update/delete tasks.
  // Per-task ownership is intentionally absent on a kanban board — the team
  // collaborates on cards. The activity log (future feature) records who did what.
  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireTeamRole('MEMBER', 'MANAGER'));

  r.post('/', {
    schema: {
      tags: ['tasks'],
      summary: 'Create a task in this project',
      params: z.object({ teamId: z.string(), projectId: z.string() }),
      body: createTaskBody,
      response: { 201: taskResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.create,
  });

  r.get('/', {
    schema: {
      tags: ['tasks'],
      summary: 'List tasks in this project (optionally filtered by status)',
      params: z.object({ teamId: z.string(), projectId: z.string() }),
      querystring: listTasksQuery,
      response: { 200: z.array(taskResponse) },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.list,
  });

  r.get('/:taskId', {
    schema: {
      tags: ['tasks'],
      summary: 'Get a task',
      params: z.object({ teamId: z.string(), projectId: z.string(), taskId: z.string() }),
      response: { 200: taskResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.get,
  });

  r.patch('/:taskId', {
    schema: {
      tags: ['tasks'],
      summary: 'Update a task (any team member)',
      params: z.object({ teamId: z.string(), projectId: z.string(), taskId: z.string() }),
      body: updateTaskBody,
      response: { 200: taskResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.update,
  });

  r.delete('/:taskId', {
    schema: {
      tags: ['tasks'],
      summary: 'Delete a task (any team member)',
      params: z.object({ teamId: z.string(), projectId: z.string(), taskId: z.string() }),
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.remove,
  });
}

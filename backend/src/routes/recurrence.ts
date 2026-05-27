import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { TaskTemplatesService } from '../services/taskTemplatesService.js';
import { TasksService } from '../services/tasksService.js';
import { RecurrenceController } from '../controllers/recurrenceController.js';
import { requireAuth, requireTeamRole } from '../middleware/auth.js';
import { requireScope } from '../middleware/requireScope.js';
import { recurrenceResponse, recurrenceUpsertBody } from '../schemas/recurrence.js';

// Recurrence CRUD nested under a single task. Mounted at
// /api/teams/:teamId/projects/:projectId/tasks/:taskId/recurrence
// so the existing requireTeamRole hook applies (any team member can
// view; MEMBER+ can mutate per the same gate used on the task PATCH).
export async function recurrenceRoutes(app: FastifyInstance): Promise<void> {
  const tasksSvc = new TasksService();
  const templatesSvc = new TaskTemplatesService();
  const ctrl = new RecurrenceController(templatesSvc, tasksSvc);
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireTeamRole('MEMBER', 'MANAGER'));

  const params = z.object({
    teamId: z.string(),
    projectId: z.string(),
    taskId: z.string(),
  });

  r.get('/', {
    preHandler: requireScope('tasks:read'),
    schema: {
      tags: ['recurrence'],
      summary: "Read the task's recurrence rule (204 when none)",
      params,
      response: { 200: recurrenceResponse, 204: z.null() },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.get,
  });

  r.put('/', {
    preHandler: requireScope('tasks:write'),
    schema: {
      tags: ['recurrence'],
      summary: 'Create or replace the recurrence rule on this task',
      params,
      body: recurrenceUpsertBody,
      response: { 200: recurrenceResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.upsert,
  });

  r.delete('/', {
    preHandler: requireScope('tasks:write'),
    schema: {
      tags: ['recurrence'],
      summary: 'Remove the recurrence rule (existing spawned tasks stay)',
      params,
      response: { 204: z.null() },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.remove,
  });

  r.post('/tick', {
    preHandler: requireScope('tasks:write'),
    schema: {
      tags: ['recurrence'],
      summary: 'Manually run the recurrence scheduler once (ops / tests)',
      params,
      response: { 200: z.object({ spawned: z.number().int() }) },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.tickNow,
  });
}

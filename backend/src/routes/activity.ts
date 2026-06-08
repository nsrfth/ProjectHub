import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ActivityController } from '../controllers/activityController.js';
import { TasksService } from '../services/tasksService.js';
import { requireAuth, requireTeamRole } from '../middleware/auth.js';
import { requireProjectAccess } from '../middleware/requireProjectAccess.js';
import { requireScope } from '../middleware/requireScope.js';
import { activityResponse } from '../schemas/activity.js';

export async function activityRoutes(app: FastifyInstance): Promise<void> {
  const tasks = new TasksService();
  const ctrl = new ActivityController(tasks);
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireTeamRole('MEMBER', 'MANAGER'));
  // v1.39: project visibility cascade.
  r.addHook('preHandler', requireProjectAccess());
  r.addHook('preHandler', requireScope('tasks:read'));

  r.get('/', {
    schema: {
      tags: ['activity'],
      summary: 'List recent activity entries for a task (newest first, capped at 200)',
      params: z.object({ teamId: z.string(), projectId: z.string(), taskId: z.string() }),
      response: { 200: z.array(activityResponse) },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.list,
  });
}

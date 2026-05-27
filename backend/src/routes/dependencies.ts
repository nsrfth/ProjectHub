import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { DependenciesService } from '../services/dependenciesService.js';
import { TasksService } from '../services/tasksService.js';
import { DependenciesController } from '../controllers/dependenciesController.js';
import { requireAuth, requireTeamRole } from '../middleware/auth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { requireScope } from '../middleware/requireScope.js';
import {
  createDependencyBody,
  dependencyIdParams,
  dependencyListResponse,
  dependencyParams,
  dependencyEdgeResponse,
} from '../schemas/dependencies.js';

// v1.29: task-dependency routes. Mounted at
// /api/teams/:teamId/projects/:projectId/tasks/:taskId/dependencies so the
// existing requireTeamRole hook applies (any member can read; the
// `task.manage_dependencies` permission gates writes).
export async function dependenciesRoutes(app: FastifyInstance): Promise<void> {
  const tasksSvc = new TasksService();
  const svc = new DependenciesService();
  const ctrl = new DependenciesController(svc, tasksSvc);
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireTeamRole('MEMBER', 'MANAGER'));

  r.get('/', {
    preHandler: requireScope('tasks:read'),
    schema: {
      tags: ['dependencies'],
      summary: 'List dependency edges incident to this task (both directions)',
      params: dependencyParams,
      response: { 200: dependencyListResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.list,
  });

  r.post('/', {
    preHandler: [requirePermission('task.manage_dependencies'), requireScope('tasks:write')],
    schema: {
      tags: ['dependencies'],
      summary:
        'Add a dependency: this task becomes blocked by dependsOnId. ' +
        'Rejects self-loops (400), cross-team / wrong-project (403/400), ' +
        'cycles (409 DEPENDENCY_CYCLE), and duplicate edges (409).',
      params: dependencyParams,
      body: createDependencyBody,
      response: { 201: dependencyEdgeResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.create,
  });

  r.delete('/:dependencyId', {
    preHandler: [requirePermission('task.manage_dependencies'), requireScope('tasks:write')],
    schema: {
      tags: ['dependencies'],
      summary: 'Remove a dependency edge by id',
      params: dependencyIdParams,
      response: { 204: z.null() },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.remove,
  });
}

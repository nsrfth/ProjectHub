import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { TasksService } from '../services/tasksService.js';
import { TasksController } from '../controllers/tasksController.js';
import { requireAuth, requireTeamRoleOrGrantedProject } from '../middleware/auth.js';
import { requireProjectAccess, requireProjectWriteAccess } from '../middleware/requireProjectAccess.js';
import { requireScope } from '../middleware/requireScope.js';
import {
  createTaskBody,
  listTasksQuery,
  rejectTaskBody,
  reorderTaskBody,
  responsibleCandidatesResponse,
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
  r.addHook('preHandler', requireTeamRoleOrGrantedProject('MEMBER', 'MANAGER'));
  // v1.39 (BREAKING): nested routes 404 for non-ADMIN non-owners. Without
  // this, URL-guessing `/projects/P/tasks` would bypass the projects-list
  // visibility filter.
  r.addHook('preHandler', requireProjectAccess());

  r.post('/', {
    preHandler: [requireProjectWriteAccess(), requireScope('tasks:write')],
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

  r.get('/responsible-candidates', {
    preHandler: requireScope('tasks:read'),
    schema: {
      tags: ['tasks'],
      summary:
        'List users eligible to be set as responsible on tasks in this project (team members ∪ accepted group-granted members)',
      params: z.object({ teamId: z.string(), projectId: z.string() }),
      response: { 200: responsibleCandidatesResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.listResponsibleCandidates,
  });

  r.get('/', {
    preHandler: requireScope('tasks:read'),
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
    preHandler: requireScope('tasks:read'),
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
    // v1.88: not requireProjectWriteAccess — a granular delegate (project READ)
    // may edit the fields their capabilities cover. tasksService.update enforces
    // write-vs-capability per field; the route-level requireProjectAccess hook
    // still blocks non-members (READ minimum).
    preHandler: requireScope('tasks:write'),
    schema: {
      tags: ['tasks'],
      summary: 'Update a task (write access or a matching delegate capability)',
      params: z.object({ teamId: z.string(), projectId: z.string(), taskId: z.string() }),
      body: updateTaskBody,
      response: { 200: taskResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.update,
  });

  r.post('/:taskId/reorder', {
    preHandler: [requireProjectWriteAccess(), requireScope('tasks:write')],
    schema: {
      tags: ['tasks'],
      summary: 'Move a task to a target column at a specific position',
      params: z.object({ teamId: z.string(), projectId: z.string(), taskId: z.string() }),
      body: reorderTaskBody,
      response: { 200: taskResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.reorder,
  });

  // v1.87: approval decisions. Deliberately NOT requireProjectWriteAccess — the
  // designated approver may hold only READ project access; the service's
  // finalizer check (approver / MANAGER / ADMIN / delegate) is the real gate.
  r.post('/:taskId/approve', {
    preHandler: requireScope('tasks:write'),
    schema: {
      tags: ['tasks'],
      summary: 'Approve a task pending approval (→ DONE)',
      params: z.object({ teamId: z.string(), projectId: z.string(), taskId: z.string() }),
      response: { 200: taskResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.approve,
  });

  r.post('/:taskId/reject', {
    preHandler: requireScope('tasks:write'),
    schema: {
      tags: ['tasks'],
      summary: 'Reject a task pending approval, with a reason (→ IN_PROGRESS)',
      params: z.object({ teamId: z.string(), projectId: z.string(), taskId: z.string() }),
      body: rejectTaskBody,
      response: { 200: taskResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.reject,
  });

  r.delete('/:taskId', {
    // v1.88: not requireProjectWriteAccess — a DELETE_TASKS delegate may delete.
    // tasksService.remove enforces write-or-capability.
    preHandler: requireScope('tasks:write'),
    schema: {
      tags: ['tasks'],
      summary: 'Delete a task (write access or the DELETE_TASKS delegate capability)',
      params: z.object({ teamId: z.string(), projectId: z.string(), taskId: z.string() }),
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.remove,
  });
}

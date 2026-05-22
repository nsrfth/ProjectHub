import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { SubtasksService } from '../services/subtasksService.js';
import { SubtasksController } from '../controllers/subtasksController.js';
import { requireAuth, requireTeamRole } from '../middleware/auth.js';
import { createSubtaskBody, subtaskResponse, updateSubtaskBody } from '../schemas/subtasks.js';

// Subtasks live under /api/teams/:teamId/projects/:projectId/tasks/:taskId/subtasks.
// There's no GET list endpoint — the parent task response already carries
// `subtasks: [...]` (see tasksService.TASK_INCLUDE).
export async function subtasksRoutes(app: FastifyInstance): Promise<void> {
  const svc = new SubtasksService();
  const ctrl = new SubtasksController(svc);
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireTeamRole('MEMBER', 'MANAGER'));

  r.post('/', {
    schema: {
      tags: ['subtasks'],
      summary: 'Add a subtask (appended to the end)',
      params: z.object({ teamId: z.string(), projectId: z.string(), taskId: z.string() }),
      body: createSubtaskBody,
      response: { 201: subtaskResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.create,
  });

  r.patch('/:subtaskId', {
    schema: {
      tags: ['subtasks'],
      summary: 'Update a subtask title and/or done flag',
      params: z.object({
        teamId: z.string(),
        projectId: z.string(),
        taskId: z.string(),
        subtaskId: z.string(),
      }),
      body: updateSubtaskBody,
      response: { 200: subtaskResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.update,
  });

  r.delete('/:subtaskId', {
    schema: {
      tags: ['subtasks'],
      summary: 'Delete a subtask',
      params: z.object({
        teamId: z.string(),
        projectId: z.string(),
        taskId: z.string(),
        subtaskId: z.string(),
      }),
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.remove,
  });
}

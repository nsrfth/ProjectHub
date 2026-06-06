import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { CommentsService } from '../services/commentsService.js';
import { TasksService } from '../services/tasksService.js';
import { CommentsController } from '../controllers/commentsController.js';
import { requireAuth, requireTeamRole } from '../middleware/auth.js';
import { requireScope } from '../middleware/requireScope.js';
import {
  commentResponse,
  createCommentBody,
  updateCommentBody,
} from '../schemas/comments.js';

// Comments live at /api/teams/:teamId/projects/:projectId/tasks/:taskId/comments
// so requireTeamRole resolves :teamId and the controller's chain-check resolves
// the rest before any comment-level work happens.
export async function commentsRoutes(app: FastifyInstance): Promise<void> {
  const svc = new CommentsService();
  const tasks = new TasksService();
  const ctrl = new CommentsController(tasks, svc);
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireTeamRole('MEMBER', 'MANAGER'));

  r.post('/', {
    preHandler: requireScope('comments:write'),
    schema: {
      tags: ['comments'],
      summary: 'Add a comment to a task',
      params: z.object({ teamId: z.string(), projectId: z.string(), taskId: z.string() }),
      body: createCommentBody,
      response: { 201: commentResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.create,
  });

  r.get('/', {
    preHandler: requireScope('comments:read'),
    schema: {
      tags: ['comments'],
      summary: 'List comments on a task (oldest first)',
      params: z.object({ teamId: z.string(), projectId: z.string(), taskId: z.string() }),
      response: { 200: z.array(commentResponse) },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.list,
  });

  r.patch('/:commentId', {
    preHandler: requireScope('comments:write'),
    schema: {
      tags: ['comments'],
      summary: 'Edit a comment (author only)',
      params: z.object({
        teamId: z.string(),
        projectId: z.string(),
        taskId: z.string(),
        commentId: z.string(),
      }),
      body: updateCommentBody,
      response: { 200: commentResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.update,
  });

  r.delete('/:commentId', {
    preHandler: requireScope('comments:write'),
    schema: {
      tags: ['comments'],
      summary: 'Delete a comment (author OR team MANAGER)',
      params: z.object({
        teamId: z.string(),
        projectId: z.string(),
        taskId: z.string(),
        commentId: z.string(),
      }),
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.remove,
  });
}

import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { requireScope } from '../middleware/requireScope.js';
import { Errors } from '../lib/errors.js';
import {
  createStandaloneTaskBody,
  listStandaloneTasksQuery,
  promoteStandaloneTaskBody,
  promoteStandaloneTaskResponse,
  reorderStandaloneTasksBody,
  standaloneTaskItem,
  standaloneTasksResponse,
  updateStandaloneTaskBody,
} from '../schemas/standaloneTasks.js';
import { StandaloneTasksService } from '../services/standaloneTasksService.js';

const svc = new StandaloneTasksService();
const idParams = z.object({ id: z.string() });

// v2.5.28 (StandaloneTask, Option C): personal-task CRUD under /api/me. Mirrors
// meTasks conventions — requireAuth + tasks:read/write scopes, tags:['me']. All
// owner-scoped; no team/project machinery.
export async function meStandaloneTasksRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook('preHandler', requireAuth);

  const read = requireScope('tasks:read');
  const write = requireScope('tasks:write');
  const uid = (req: { user?: { sub: string } }): string => {
    if (!req.user) throw Errors.unauthorized();
    return req.user.sub;
  };

  r.get('/standalone-tasks', {
    preHandler: read,
    schema: {
      tags: ['me'],
      summary: 'List the current user\'s personal (standalone) tasks',
      querystring: listStandaloneTasksQuery,
      response: { 200: standaloneTasksResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      const items = await svc.list(uid(req), req.query);
      return reply.send({ items });
    },
  });

  r.post('/standalone-tasks', {
    preHandler: write,
    schema: {
      tags: ['me'],
      summary: 'Create a personal task',
      body: createStandaloneTaskBody,
      response: { 201: standaloneTaskItem },
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      const item = await svc.create(uid(req), req.body);
      return reply.code(201).send(item);
    },
  });

  r.patch('/standalone-tasks/:id', {
    preHandler: write,
    schema: {
      tags: ['me'],
      summary: 'Update a personal task',
      params: idParams,
      body: updateStandaloneTaskBody,
      response: { 200: standaloneTaskItem },
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      const item = await svc.update(uid(req), req.params.id, req.body);
      return reply.send(item);
    },
  });

  r.delete('/standalone-tasks/:id', {
    preHandler: write,
    schema: {
      tags: ['me'],
      summary: 'Soft-delete a personal task (recoverable)',
      params: idParams,
      response: { 204: z.null() },
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      await svc.remove(uid(req), req.params.id);
      return reply.code(204).send();
    },
  });

  r.post('/standalone-tasks/:id/restore', {
    preHandler: write,
    schema: {
      tags: ['me'],
      summary: 'Restore a soft-deleted personal task',
      params: idParams,
      response: { 200: standaloneTaskItem },
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      const item = await svc.restore(uid(req), req.params.id);
      return reply.send(item);
    },
  });

  r.post('/standalone-tasks/reorder', {
    preHandler: write,
    schema: {
      tags: ['me'],
      summary: 'Reorder personal tasks within a status column',
      body: reorderStandaloneTasksBody,
      response: { 200: standaloneTasksResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      const items = await svc.reorder(uid(req), req.body);
      return reply.send({ items });
    },
  });

  r.post('/standalone-tasks/:id/promote', {
    preHandler: write,
    schema: {
      tags: ['me'],
      summary: 'Promote a personal task to a real project task',
      params: idParams,
      body: promoteStandaloneTaskBody,
      response: { 200: promoteStandaloneTaskResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      if (!req.user) throw Errors.unauthorized();
      const result = await svc.promote(req.user.sub, req.user.globalRole, req.params.id, req.body);
      return reply.send(result);
    },
  });
}

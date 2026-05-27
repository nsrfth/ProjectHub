import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { TeamMembership } from '@prisma/client';
import { z } from 'zod';
import { TrashService } from '../services/trashService.js';
import { requireAuth, requireTeamRole } from '../middleware/auth.js';
import { requireScope } from '../middleware/requireScope.js';
import { Errors } from '../lib/errors.js';

// v1.21: trash routes. Mounted at /api/teams/:teamId/trash. Team membership
// is enforced by requireTeamRole; the per-action role gate (admin-only or
// admin-and-manager for purge/empty) lives in TrashService.

function callerMembership(req: FastifyRequest): TeamMembership {
  const m = (req as unknown as { membership?: TeamMembership }).membership;
  if (!m) throw Errors.internal('Missing team membership context');
  return m;
}

export async function trashRoutes(app: FastifyInstance): Promise<void> {
  const svc = new TrashService();
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireTeamRole('MEMBER', 'MANAGER'));

  r.get('/', {
    preHandler: requireScope('tasks:read'),
    schema: {
      tags: ['trash'],
      summary: 'List soft-deleted tasks + comments in this team',
      params: z.object({ teamId: z.string() }),
      response: {
        200: z.object({
          tasks: z.array(z.object({
            kind: z.literal('task'),
            id: z.string(),
            title: z.string(),
            projectId: z.string(),
            deletedAt: z.string(),
            deletedById: z.string().nullable(),
            deletedByName: z.string().nullable(),
          })),
          comments: z.array(z.object({
            kind: z.literal('comment'),
            id: z.string(),
            taskId: z.string(),
            bodyExcerpt: z.string(),
            deletedAt: z.string(),
            deletedById: z.string().nullable(),
            deletedByName: z.string().nullable(),
          })),
          emptyAllowedRoles: z.enum(['admin', 'admin-and-manager']),
        }),
      },
      security: [{ bearerAuth: [] }],
    },
    handler: async (req: FastifyRequest<{ Params: { teamId: string } }>, reply: FastifyReply) => {
      const out = await svc.list(req.params.teamId);
      return reply.send({
        tasks: out.tasks.map((t) => ({ ...t, deletedAt: t.deletedAt.toISOString() })),
        comments: out.comments.map((c) => ({ ...c, deletedAt: c.deletedAt.toISOString() })),
        emptyAllowedRoles: out.emptyAllowedRoles,
      });
    },
  });

  r.post('/tasks/:taskId/restore', {
    preHandler: requireScope('tasks:write'),
    schema: {
      tags: ['trash'],
      summary: 'Restore a soft-deleted task',
      params: z.object({ teamId: z.string(), taskId: z.string() }),
      response: { 204: z.null() },
      security: [{ bearerAuth: [] }],
    },
    handler: async (
      req: FastifyRequest<{ Params: { teamId: string; taskId: string } }>,
      reply: FastifyReply,
    ) => {
      await svc.restoreTask(req.params.teamId, req.params.taskId);
      return reply.status(204).send();
    },
  });

  r.post('/comments/:commentId/restore', {
    preHandler: requireScope('comments:write'),
    schema: {
      tags: ['trash'],
      summary: 'Restore a soft-deleted comment',
      params: z.object({ teamId: z.string(), commentId: z.string() }),
      response: { 204: z.null() },
      security: [{ bearerAuth: [] }],
    },
    handler: async (
      req: FastifyRequest<{ Params: { teamId: string; commentId: string } }>,
      reply: FastifyReply,
    ) => {
      await svc.restoreComment(req.params.teamId, req.params.commentId);
      return reply.status(204).send();
    },
  });

  // Hard delete — gated to admin (or admin + manager) per the instance setting.
  r.delete('/tasks/:taskId', {
    preHandler: requireScope('admin'),
    schema: {
      tags: ['trash'],
      summary: 'Permanently delete a trashed task (admin-gated)',
      params: z.object({ teamId: z.string(), taskId: z.string() }),
      response: { 204: z.null() },
      security: [{ bearerAuth: [] }],
    },
    handler: async (
      req: FastifyRequest<{ Params: { teamId: string; taskId: string } }>,
      reply: FastifyReply,
    ) => {
      if (!req.user) throw Errors.unauthorized();
      const m = callerMembership(req);
      await svc.purgeTask(
        req.params.teamId,
        req.params.taskId,
        req.user.sub,
        m.role,
        req.user.globalRole,
      );
      return reply.status(204).send();
    },
  });

  r.delete('/comments/:commentId', {
    preHandler: requireScope('admin'),
    schema: {
      tags: ['trash'],
      summary: 'Permanently delete a trashed comment (admin-gated)',
      params: z.object({ teamId: z.string(), commentId: z.string() }),
      response: { 204: z.null() },
      security: [{ bearerAuth: [] }],
    },
    handler: async (
      req: FastifyRequest<{ Params: { teamId: string; commentId: string } }>,
      reply: FastifyReply,
    ) => {
      if (!req.user) throw Errors.unauthorized();
      const m = callerMembership(req);
      await svc.purgeComment(
        req.params.teamId,
        req.params.commentId,
        req.user.sub,
        m.role,
        req.user.globalRole,
      );
      return reply.status(204).send();
    },
  });

  // Bulk empty — same gate. Returns the counts of what was purged so the SPA
  // can render a "47 tasks + 12 comments permanently deleted" confirmation.
  r.post('/empty', {
    preHandler: requireScope('admin'),
    schema: {
      tags: ['trash'],
      summary: 'Permanently delete EVERYTHING in this team\'s trash (admin-gated)',
      params: z.object({ teamId: z.string() }),
      response: {
        200: z.object({
          tasksPurged: z.number().int(),
          commentsPurged: z.number().int(),
        }),
      },
      security: [{ bearerAuth: [] }],
    },
    handler: async (req: FastifyRequest<{ Params: { teamId: string } }>, reply: FastifyReply) => {
      if (!req.user) throw Errors.unauthorized();
      const m = callerMembership(req);
      const counts = await svc.empty(
        req.params.teamId,
        req.user.sub,
        m.role,
        req.user.globalRole,
      );
      return reply.send(counts);
    },
  });
}

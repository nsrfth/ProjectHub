import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ProjectsService } from '../services/projectsService.js';
import { requireAuth, requireGlobalRole } from '../middleware/auth.js';
import { requireScope } from '../middleware/requireScope.js';
import {
  setTeamSharesBody,
  teamShareListResponse,
} from '../schemas/projects.js';
import { Errors } from '../lib/errors.js';

const params = z.object({ teamId: z.string(), projectId: z.string() });

function serializeShare(s: {
  teamId: string;
  teamName: string;
  teamSlug: string;
  level: 'FULL' | 'READONLY';
  createdAt: Date;
}) {
  return { ...s, createdAt: s.createdAt.toISOString() };
}

/**
 * v2.5.58: whole-team project sharing — global-ADMIN only.
 * Mounted at /api/teams/:teamId/projects/:projectId/team-shares (app.ts).
 * PUT is replace-set (same shape as group project grants / edit delegates).
 */
export async function projectTeamSharesRoutes(app: FastifyInstance): Promise<void> {
  const svc = new ProjectsService();
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireGlobalRole('ADMIN'));

  r.get('/', {
    preHandler: requireScope('admin'),
    schema: {
      tags: ['projects'],
      summary: 'List the teams this project is shared with (global ADMIN only)',
      params,
      response: { 200: teamShareListResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      if (!req.user) throw Errors.unauthorized();
      const { teamId, projectId } = req.params as z.infer<typeof params>;
      const rows = await svc.listTeamShares(teamId, projectId);
      return reply.send(rows.map(serializeShare));
    },
  });

  r.put('/', {
    preHandler: requireScope('admin'),
    schema: {
      tags: ['projects'],
      summary: 'Replace the set of teams this project is shared with (global ADMIN only)',
      params,
      body: setTeamSharesBody,
      response: { 200: teamShareListResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      if (!req.user) throw Errors.unauthorized();
      const { teamId, projectId } = req.params as z.infer<typeof params>;
      const body = req.body as z.infer<typeof setTeamSharesBody>;
      const rows = await svc.setTeamShares(teamId, projectId, req.user.sub, body.shares);
      return reply.send(rows.map(serializeShare));
    },
  });
}

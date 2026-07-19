import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ProjectGrantsService } from '../services/projectGrantsService.js';
import { requireAuth, requireTeamRole } from '../middleware/auth.js';
import { requireScope } from '../middleware/requireScope.js';
import { Errors } from '../lib/errors.js';

// v2.8 (Phases 2+3): the unified sharing surface.
// Mounted at /api/teams/:teamId/projects/:projectId/grants (app.ts).
//
// Authorization is deliberately NOT admin-only (unlike the legacy team-shares
// routes it will replace): owner / ADMIN / project.share holders can share —
// that is D-7's register default — and the consent flow (Phase 3) is what
// keeps a project.share holder from imposing on another team.

const params = z.object({ teamId: z.string(), projectId: z.string() });
const grantParams = params.extend({ grantId: z.string() });

const grantSubjectEnum = z.enum(['USER', 'GROUP', 'TEAM', 'ORG_UNIT']);
const grantLevelEnum = z.enum(['READ', 'WRITE']);
const grantStatusEnum = z.enum(['PENDING', 'ACTIVE', 'DECLINED']);

const createGrantBody = z.object({
  subjectType: grantSubjectEnum,
  subjectId: z.string().min(1),
  level: grantLevelEnum,
  expiresAt: z.string().datetime().nullable().optional(),
});

const grantResponse = z.object({
  id: z.string(),
  projectId: z.string(),
  subjectType: grantSubjectEnum,
  subjectId: z.string(),
  subjectName: z.string(),
  level: grantLevelEnum,
  status: grantStatusEnum,
  source: z.string().nullable(),
  grantedByName: z.string().nullable(),
  grantedAt: z.string(),
  expiresAt: z.string().nullable(),
});

const grantListResponse = z.object({ items: z.array(grantResponse) });

function serialize<T extends { grantedAt: Date; expiresAt: Date | null }>(g: T) {
  return {
    ...g,
    grantedAt: g.grantedAt.toISOString(),
    expiresAt: g.expiresAt ? g.expiresAt.toISOString() : null,
  };
}

export async function projectGrantsRoutes(app: FastifyInstance): Promise<void> {
  const svc = new ProjectGrantsService();
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireTeamRole('MEMBER', 'MANAGER'));
  r.addHook('preHandler', requireScope('admin'));

  r.get('/', {
    schema: {
      tags: ['grants'],
      summary: 'List all access grants on a project (the unified sharing surface)',
      params,
      response: { 200: grantListResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const { teamId, projectId } = req.params as z.infer<typeof params>;
      const items = await svc.list(teamId, projectId);
      return reply.send({ items: items.map(serialize) });
    },
  });

  r.post('/', {
    schema: {
      tags: ['grants'],
      summary: 'Grant a subject access (PENDING when a consent boundary applies)',
      params,
      body: createGrantBody,
      response: { 201: grantResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      if (!req.user) throw Errors.unauthorized();
      const { teamId, projectId } = req.params as z.infer<typeof params>;
      const g = await svc.create(
        teamId,
        projectId,
        req.user.sub,
        req.user.globalRole,
        req.body as z.infer<typeof createGrantBody>,
      );
      return reply.status(201).send(serialize(g));
    },
  });

  r.delete('/:grantId', {
    schema: {
      tags: ['grants'],
      summary: 'Revoke a grant (mirrors into the legacy row while those exist)',
      params: grantParams,
      response: { 204: z.null() },
      security: [{ bearerAuth: [] }],
    },
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      if (!req.user) throw Errors.unauthorized();
      const { teamId, projectId, grantId } = req.params as z.infer<typeof grantParams>;
      await svc.revoke(teamId, projectId, grantId, req.user.sub, req.user.globalRole);
      return reply.status(204).send();
    },
  });
}

// Approval surface — NOT team-scoped (an approver may manage a unit in one
// team and be asked about a project in another), so mounted separately at
// /api/me/grant-approvals.
export async function grantApprovalsRoutes(app: FastifyInstance): Promise<void> {
  const svc = new ProjectGrantsService();
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);

  const pendingResponse = z.object({
    items: z.array(
      grantResponse.extend({ projectName: z.string(), teamName: z.string() }),
    ),
  });

  r.get('/', {
    schema: {
      tags: ['grants'],
      summary: 'Grants awaiting my approval (as unit manager / target-team manager)',
      response: { 200: pendingResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      if (!req.user) throw Errors.unauthorized();
      const items = await svc.pendingForApprover(req.user.sub);
      return reply.send({ items: items.map(serialize) });
    },
  });

  const decideParams = z.object({ grantId: z.string() });
  const decideBody = z.object({ decision: z.enum(['accept', 'decline']) });

  r.post('/:grantId', {
    schema: {
      tags: ['grants'],
      summary: 'Accept or decline a pending grant',
      params: decideParams,
      body: decideBody,
      response: { 200: grantResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      if (!req.user) throw Errors.unauthorized();
      const { grantId } = req.params as z.infer<typeof decideParams>;
      const { decision } = req.body as z.infer<typeof decideBody>;
      const g = await svc.decide(grantId, req.user.sub, req.user.globalRole, decision);
      return reply.send(serialize(g));
    },
  });
}

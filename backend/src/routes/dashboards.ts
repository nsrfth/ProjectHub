import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { TeamMembership } from '@prisma/client';
import { z } from 'zod';
import { DashboardsService, type DashboardView } from '../services/dashboardsService.js';
import { requireAuth, requireTeamRole } from '../middleware/auth.js';
import { requireScope } from '../middleware/requireScope.js';
import { Errors } from '../lib/errors.js';
import {
  createDashboardBody,
  dashboardResponse,
  dashboardsListResponse,
  setDashboardWidgetsBody,
  updateDashboardBody,
  widgetDataResponse,
  type CreateDashboardBody,
  type SetDashboardWidgetsBody,
  type UpdateDashboardBody,
} from '../schemas/dashboards.js';

function callerMembership(req: FastifyRequest): TeamMembership {
  const m = (req as unknown as { membership?: TeamMembership }).membership;
  if (!m) throw Errors.internal('Missing team membership context');
  return m;
}

function serializeDashboard(d: DashboardView & { canEdit: boolean }) {
  return {
    ...d,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

type TeamParams = { teamId: string };
type DashboardParams = { teamId: string; dashboardId: string };
type WidgetParams = { teamId: string; dashboardId: string; widgetId: string };

export async function dashboardsRoutes(app: FastifyInstance): Promise<void> {
  const svc = new DashboardsService();
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireTeamRole('MEMBER', 'MANAGER'));

  r.get('/', {
    preHandler: requireScope('projects:read'),
    schema: {
      tags: ['dashboards'],
      summary: 'List dashboards visible to the caller (own + shared)',
      params: z.object({ teamId: z.string() }),
      response: { 200: dashboardsListResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (req: FastifyRequest<{ Params: TeamParams }>, reply: FastifyReply) => {
      if (!req.user) throw Errors.unauthorized();
      const membership = callerMembership(req);
      const items = await svc.list(req.params.teamId, req.user.sub, membership.role);
      return reply.send({
        items: items.map((d) => ({
          ...d,
          createdAt: d.createdAt.toISOString(),
          updatedAt: d.updatedAt.toISOString(),
        })),
      });
    },
  });

  r.post('/', {
    preHandler: requireScope('projects:write'),
    schema: {
      tags: ['dashboards'],
      summary: 'Create a dashboard (caller becomes owner)',
      params: z.object({ teamId: z.string() }),
      body: createDashboardBody,
      response: { 201: dashboardResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (
      req: FastifyRequest<{ Params: TeamParams; Body: CreateDashboardBody }>,
      reply: FastifyReply,
    ) => {
      if (!req.user) throw Errors.unauthorized();
      callerMembership(req);
      const created = await svc.create(req.params.teamId, req.user.sub, req.body);
      return reply.status(201).send(
        serializeDashboard({ ...created, canEdit: true }),
      );
    },
  });

  r.get('/:dashboardId', {
    preHandler: requireScope('projects:read'),
    schema: {
      tags: ['dashboards'],
      summary: 'Get a dashboard with widgets',
      params: z.object({ teamId: z.string(), dashboardId: z.string() }),
      response: { 200: dashboardResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (req: FastifyRequest<{ Params: DashboardParams }>, reply: FastifyReply) => {
      if (!req.user) throw Errors.unauthorized();
      const membership = callerMembership(req);
      const row = await svc.get(
        req.params.teamId,
        req.params.dashboardId,
        req.user.sub,
        membership.role,
      );
      return reply.send(serializeDashboard(row));
    },
  });

  r.patch('/:dashboardId', {
    preHandler: requireScope('projects:write'),
    schema: {
      tags: ['dashboards'],
      summary: 'Update dashboard metadata (owner or manager)',
      params: z.object({ teamId: z.string(), dashboardId: z.string() }),
      body: updateDashboardBody,
      response: { 200: dashboardResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (
      req: FastifyRequest<{ Params: DashboardParams; Body: UpdateDashboardBody }>,
      reply: FastifyReply,
    ) => {
      if (!req.user) throw Errors.unauthorized();
      const membership = callerMembership(req);
      const updated = await svc.update(
        req.params.teamId,
        req.params.dashboardId,
        req.user.sub,
        membership.role,
        req.body,
      );
      return reply.send(serializeDashboard(updated));
    },
  });

  r.delete('/:dashboardId', {
    preHandler: requireScope('projects:write'),
    schema: {
      tags: ['dashboards'],
      summary: 'Delete a dashboard and its widgets',
      params: z.object({ teamId: z.string(), dashboardId: z.string() }),
      response: { 204: z.null() },
      security: [{ bearerAuth: [] }],
    },
    handler: async (req: FastifyRequest<{ Params: DashboardParams }>, reply: FastifyReply) => {
      if (!req.user) throw Errors.unauthorized();
      const membership = callerMembership(req);
      await svc.delete(
        req.params.teamId,
        req.params.dashboardId,
        req.user.sub,
        membership.role,
      );
      return reply.status(204).send();
    },
  });

  r.put('/:dashboardId/widgets', {
    preHandler: requireScope('projects:write'),
    schema: {
      tags: ['dashboards'],
      summary: 'Replace all widgets on a dashboard (idempotent)',
      params: z.object({ teamId: z.string(), dashboardId: z.string() }),
      body: setDashboardWidgetsBody,
      response: { 200: dashboardResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (
      req: FastifyRequest<{ Params: DashboardParams; Body: SetDashboardWidgetsBody }>,
      reply: FastifyReply,
    ) => {
      if (!req.user) throw Errors.unauthorized();
      const membership = callerMembership(req);
      const updated = await svc.setWidgets(
        req.params.teamId,
        req.params.dashboardId,
        req.user.sub,
        membership.role,
        req.body,
      );
      return reply.send(serializeDashboard(updated));
    },
  });

  r.get('/:dashboardId/widgets/:widgetId/data', {
    preHandler: requireScope('projects:read'),
    schema: {
      tags: ['dashboards'],
      summary: 'Resolve widget configuration to chart/table data',
      params: z.object({
        teamId: z.string(),
        dashboardId: z.string(),
        widgetId: z.string(),
      }),
      response: { 200: widgetDataResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (req: FastifyRequest<{ Params: WidgetParams }>, reply: FastifyReply) => {
      if (!req.user) throw Errors.unauthorized();
      const data = await svc.resolveWidgetData(
        req.params.teamId,
        req.params.dashboardId,
        req.params.widgetId,
        { userId: req.user.sub, globalRole: req.user.globalRole },
      );
      return reply.send(data);
    },
  });
}

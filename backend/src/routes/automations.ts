import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AutomationRulesService } from '../services/automationRulesService.js';
import { requireAuth, requireTeamRole } from '../middleware/auth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { requireScope } from '../middleware/requireScope.js';
import { Errors } from '../lib/errors.js';
import {
  automationRuleResponse,
  automationRunsPageResponse,
  createAutomationRuleBody,
  listAutomationRunsQuery,
  reorderAutomationsBody,
  updateAutomationRuleBody,
  type CreateAutomationRuleBody,
  type UpdateAutomationRuleBody,
} from '../schemas/automations.js';

type TeamParams = { teamId: string };
type RuleParams = { teamId: string; ruleId: string };

function serializeRule(r: Awaited<ReturnType<AutomationRulesService['get']>>) {
  return {
    ...r,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    lastRunAt: r.lastRunAt?.toISOString() ?? null,
  };
}

export async function automationsRoutes(app: FastifyInstance): Promise<void> {
  const svc = new AutomationRulesService();
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireTeamRole('MEMBER', 'MANAGER'));

  r.get('/', {
    preHandler: [requirePermission('automation.manage'), requireScope('admin')],
    schema: {
      tags: ['automations'],
      summary: 'List automation rules for this team',
      params: z.object({ teamId: z.string() }),
      response: { 200: z.array(automationRuleResponse) },
      security: [{ bearerAuth: [] }],
    },
    handler: async (req: FastifyRequest<{ Params: TeamParams }>, reply: FastifyReply) => {
      const items = await svc.list(req.params.teamId);
      return reply.send(items.map(serializeRule));
    },
  });

  r.post('/', {
    preHandler: [requirePermission('automation.manage'), requireScope('admin')],
    schema: {
      tags: ['automations'],
      summary: 'Create an automation rule',
      params: z.object({ teamId: z.string() }),
      body: createAutomationRuleBody,
      response: { 201: automationRuleResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (
      req: FastifyRequest<{ Params: TeamParams; Body: CreateAutomationRuleBody }>,
      reply: FastifyReply,
    ) => {
      if (!req.user) throw Errors.unauthorized();
      const created = await svc.create(req.params.teamId, req.user.sub, req.body);
      return reply.status(201).send(serializeRule(created));
    },
  });

  r.patch('/reorder', {
    preHandler: [requirePermission('automation.manage'), requireScope('admin')],
    schema: {
      tags: ['automations'],
      summary: 'Reorder automation rules',
      params: z.object({ teamId: z.string() }),
      body: reorderAutomationsBody,
      response: { 200: z.array(automationRuleResponse) },
      security: [{ bearerAuth: [] }],
    },
    handler: async (
      req: FastifyRequest<{ Params: TeamParams; Body: { orderedIds: string[] } }>,
      reply: FastifyReply,
    ) => {
      if (!req.user) throw Errors.unauthorized();
      const items = await svc.reorder(req.params.teamId, req.user.sub, req.body.orderedIds);
      return reply.send(items.map(serializeRule));
    },
  });

  r.get('/:ruleId', {
    preHandler: [requirePermission('automation.manage'), requireScope('admin')],
    schema: {
      tags: ['automations'],
      summary: 'Get an automation rule',
      params: z.object({ teamId: z.string(), ruleId: z.string() }),
      response: { 200: automationRuleResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (req: FastifyRequest<{ Params: RuleParams }>, reply: FastifyReply) => {
      const rule = await svc.get(req.params.teamId, req.params.ruleId);
      return reply.send(serializeRule(rule));
    },
  });

  r.patch('/:ruleId', {
    preHandler: [requirePermission('automation.manage'), requireScope('admin')],
    schema: {
      tags: ['automations'],
      summary: 'Update an automation rule',
      params: z.object({ teamId: z.string(), ruleId: z.string() }),
      body: updateAutomationRuleBody,
      response: { 200: automationRuleResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (
      req: FastifyRequest<{ Params: RuleParams; Body: UpdateAutomationRuleBody }>,
      reply: FastifyReply,
    ) => {
      if (!req.user) throw Errors.unauthorized();
      const updated = await svc.update(req.params.teamId, req.params.ruleId, req.user.sub, req.body);
      return reply.send(serializeRule(updated));
    },
  });

  r.delete('/:ruleId', {
    preHandler: [requirePermission('automation.manage'), requireScope('admin')],
    schema: {
      tags: ['automations'],
      summary: 'Delete an automation rule',
      params: z.object({ teamId: z.string(), ruleId: z.string() }),
      response: { 204: z.null() },
      security: [{ bearerAuth: [] }],
    },
    handler: async (req: FastifyRequest<{ Params: RuleParams }>, reply: FastifyReply) => {
      if (!req.user) throw Errors.unauthorized();
      await svc.remove(req.params.teamId, req.params.ruleId, req.user.sub);
      return reply.status(204).send();
    },
  });

  r.get('/:ruleId/runs', {
    preHandler: [requirePermission('automation.manage'), requireScope('admin')],
    schema: {
      tags: ['automations'],
      summary: 'List recent execution log for a rule',
      params: z.object({ teamId: z.string(), ruleId: z.string() }),
      querystring: listAutomationRunsQuery,
      response: { 200: automationRunsPageResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (
      req: FastifyRequest<{ Params: RuleParams; Querystring: { page?: number; pageSize?: number } }>,
      reply: FastifyReply,
    ) => {
      const q = listAutomationRunsQuery.parse(req.query);
      const page = await svc.listRuns(req.params.teamId, req.params.ruleId, q.page, q.pageSize);
      return reply.send({
        ...page,
        items: page.items.map((run) => ({
          ...run,
          status: run.status as 'SUCCESS' | 'SKIPPED' | 'ERROR',
          createdAt: run.createdAt.toISOString(),
        })),
      });
    },
  });
}

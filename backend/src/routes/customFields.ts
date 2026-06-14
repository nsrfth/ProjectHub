import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  CustomFieldsService,
  type CustomFieldDefinitionView,
} from '../services/customFieldsService.js';
import { requireAuth, requireTeamRole, requireTeamRoleOrGrantedProject } from '../middleware/auth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { requireProjectAccess, requireProjectWriteAccess } from '../middleware/requireProjectAccess.js';
import { requireScope } from '../middleware/requireScope.js';
import { Errors } from '../lib/errors.js';
import {
  createCustomFieldBody,
  customFieldDefinitionResponse,
  setCustomFieldOptionsBody,
  setTaskCustomFieldValueBody,
  taskCustomFieldValueResponse,
  updateCustomFieldBody,
  type CreateCustomFieldBody,
  type SetCustomFieldOptionsBody,
  type SetTaskCustomFieldValueBody,
  type UpdateCustomFieldBody,
} from '../schemas/customFields.js';

function serializeDefinition(d: CustomFieldDefinitionView) {
  return {
    ...d,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

type TeamParams = { teamId: string };
type FieldParams = { teamId: string; fieldId: string };
type TaskFieldParams = { teamId: string; projectId: string; taskId: string; fieldId: string };

export async function customFieldsRoutes(app: FastifyInstance): Promise<void> {
  const svc = new CustomFieldsService();
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireTeamRole('MEMBER', 'MANAGER'));

  r.get('/', {
    preHandler: requireScope('projects:read'),
    schema: {
      tags: ['custom-fields'],
      summary: 'List custom field definitions for this team',
      params: z.object({ teamId: z.string() }),
      response: { 200: z.array(customFieldDefinitionResponse) },
      security: [{ bearerAuth: [] }],
    },
    handler: async (req: FastifyRequest<{ Params: TeamParams }>, reply: FastifyReply) => {
      const items = await svc.listDefinitions(req.params.teamId);
      return reply.send(items.map(serializeDefinition));
    },
  });

  r.post('/', {
    preHandler: [requirePermission('customfield.manage'), requireScope('admin')],
    schema: {
      tags: ['custom-fields'],
      summary: 'Create a custom field definition',
      params: z.object({ teamId: z.string() }),
      body: createCustomFieldBody,
      response: { 201: customFieldDefinitionResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (
      req: FastifyRequest<{ Params: TeamParams; Body: CreateCustomFieldBody }>,
      reply: FastifyReply,
    ) => {
      if (!req.user) throw Errors.unauthorized();
      const created = await svc.createDefinition(req.params.teamId, req.user.sub, req.body);
      return reply.status(201).send(serializeDefinition(created));
    },
  });

  r.get('/:fieldId', {
    preHandler: requireScope('projects:read'),
    schema: {
      tags: ['custom-fields'],
      summary: 'Get a custom field definition',
      params: z.object({ teamId: z.string(), fieldId: z.string() }),
      response: { 200: customFieldDefinitionResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (req: FastifyRequest<{ Params: FieldParams }>, reply: FastifyReply) => {
      const row = await svc.getDefinition(req.params.teamId, req.params.fieldId);
      return reply.send(serializeDefinition(row));
    },
  });

  r.patch('/:fieldId', {
    preHandler: [requirePermission('customfield.manage'), requireScope('admin')],
    schema: {
      tags: ['custom-fields'],
      summary: 'Update a custom field definition',
      params: z.object({ teamId: z.string(), fieldId: z.string() }),
      body: updateCustomFieldBody,
      response: { 200: customFieldDefinitionResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (
      req: FastifyRequest<{ Params: FieldParams; Body: UpdateCustomFieldBody }>,
      reply: FastifyReply,
    ) => {
      if (!req.user) throw Errors.unauthorized();
      const updated = await svc.updateDefinition(
        req.params.teamId,
        req.params.fieldId,
        req.user.sub,
        req.body,
      );
      return reply.send(serializeDefinition(updated));
    },
  });

  r.delete('/:fieldId', {
    preHandler: [requirePermission('customfield.manage'), requireScope('admin')],
    schema: {
      tags: ['custom-fields'],
      summary: 'Delete a custom field (cascades values and options)',
      params: z.object({ teamId: z.string(), fieldId: z.string() }),
      response: { 204: z.null() },
      security: [{ bearerAuth: [] }],
    },
    handler: async (req: FastifyRequest<{ Params: FieldParams }>, reply: FastifyReply) => {
      if (!req.user) throw Errors.unauthorized();
      await svc.deleteDefinition(req.params.teamId, req.params.fieldId, req.user.sub);
      return reply.status(204).send();
    },
  });

  r.put('/:fieldId/options', {
    preHandler: [requirePermission('customfield.manage'), requireScope('admin')],
    schema: {
      tags: ['custom-fields'],
      summary: 'Replace select options on a custom field (idempotent)',
      params: z.object({ teamId: z.string(), fieldId: z.string() }),
      body: setCustomFieldOptionsBody,
      response: { 200: customFieldDefinitionResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (
      req: FastifyRequest<{ Params: FieldParams; Body: SetCustomFieldOptionsBody }>,
      reply: FastifyReply,
    ) => {
      if (!req.user) throw Errors.unauthorized();
      const updated = await svc.setOptions(
        req.params.teamId,
        req.params.fieldId,
        req.user.sub,
        req.body,
      );
      return reply.send(serializeDefinition(updated));
    },
  });
}

export async function taskCustomFieldsRoutes(app: FastifyInstance): Promise<void> {
  const svc = new CustomFieldsService();
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireTeamRoleOrGrantedProject('MEMBER', 'MANAGER'));
  r.addHook('preHandler', requireProjectAccess());

  r.put('/:fieldId', {
    preHandler: [requireProjectWriteAccess(), requireScope('tasks:write')],
    schema: {
      tags: ['custom-fields'],
      summary: 'Set or clear a custom field value on this task',
      params: z.object({
        teamId: z.string(),
        projectId: z.string(),
        taskId: z.string(),
        fieldId: z.string(),
      }),
      body: setTaskCustomFieldValueBody,
      response: { 200: z.array(taskCustomFieldValueResponse) },
      security: [{ bearerAuth: [] }],
    },
    handler: async (
      req: FastifyRequest<{ Params: TaskFieldParams; Body: SetTaskCustomFieldValueBody }>,
      reply: FastifyReply,
    ) => {
      if (!req.user) throw Errors.unauthorized();
      const values = await svc.setTaskValue(
        req.params.teamId,
        req.params.projectId,
        req.params.taskId,
        req.params.fieldId,
        req.user.sub,
        req.body,
      );
      return reply.send(values);
    },
  });
}

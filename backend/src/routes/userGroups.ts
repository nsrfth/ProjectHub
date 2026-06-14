import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { Errors } from '../lib/errors.js';
import { UserGroupsService, type UserGroupDetail, type UserGroupSummary } from '../services/userGroupsService.js';
import { requireAuth, requireTeamRole } from '../middleware/auth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { requireScope } from '../middleware/requireScope.js';
import {
  addGroupMembersBody,
  createUserGroupBody,
  setGroupProjectsBody,
  updateUserGroupBody,
  userGroupDetailResponse,
  userGroupsListResponse,
  type AddGroupMembersBody,
  type CreateUserGroupBody,
  type SetGroupProjectsBody,
  type UpdateUserGroupBody,
} from '../schemas/userGroups.js';

function serializeSummary(g: UserGroupSummary) {
  return {
    ...g,
    createdAt: g.createdAt.toISOString(),
    updatedAt: g.updatedAt.toISOString(),
  };
}

function serializeDetail(g: UserGroupDetail) {
  return {
    ...serializeSummary(g),
    members: g.members.map((m) => ({ ...m, addedAt: m.addedAt.toISOString() })),
    projects: g.projects.map((p) => ({ ...p, grantedAt: p.grantedAt.toISOString() })),
  };
}

type TeamParams = { teamId: string };
type GroupParams = { teamId: string; groupId: string };
type GroupMemberParams = { teamId: string; groupId: string; userId: string };

export async function userGroupsRoutes(app: FastifyInstance): Promise<void> {
  const svc = new UserGroupsService();
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireTeamRole('MEMBER', 'MANAGER'));

  r.get('/', {
    preHandler: requireScope('projects:read'),
    schema: {
      tags: ['groups'],
      summary: 'List user groups in this team',
      params: z.object({ teamId: z.string() }),
      response: { 200: userGroupsListResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (req: FastifyRequest<{ Params: TeamParams }>, reply: FastifyReply) => {
      const items = await svc.list(req.params.teamId);
      return reply.send({ items: items.map(serializeSummary) });
    },
  });

  r.post('/', {
    preHandler: [requirePermission('group.manage'), requireScope('admin')],
    schema: {
      tags: ['groups'],
      summary: 'Create a user group',
      params: z.object({ teamId: z.string() }),
      body: createUserGroupBody,
      response: { 201: userGroupDetailResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (
      req: FastifyRequest<{ Params: TeamParams; Body: CreateUserGroupBody }>,
      reply: FastifyReply,
    ) => {
      if (!req.user) throw Errors.unauthorized();
      const created = await svc.create(req.params.teamId, req.user.sub, req.body);
      const detail = await svc.get(req.params.teamId, created.id);
      return reply.status(201).send(serializeDetail(detail));
    },
  });

  r.get('/:groupId', {
    preHandler: requireScope('projects:read'),
    schema: {
      tags: ['groups'],
      summary: 'Get group detail (members + granted projects)',
      params: z.object({ teamId: z.string(), groupId: z.string() }),
      response: { 200: userGroupDetailResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (req: FastifyRequest<{ Params: GroupParams }>, reply: FastifyReply) => {
      const detail = await svc.get(req.params.teamId, req.params.groupId);
      return reply.send(serializeDetail(detail));
    },
  });

  r.patch('/:groupId', {
    preHandler: [requirePermission('group.manage'), requireScope('admin')],
    schema: {
      tags: ['groups'],
      summary: 'Rename or update group description',
      params: z.object({ teamId: z.string(), groupId: z.string() }),
      body: updateUserGroupBody,
      response: { 200: userGroupDetailResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (
      req: FastifyRequest<{ Params: GroupParams; Body: UpdateUserGroupBody }>,
      reply: FastifyReply,
    ) => {
      if (!req.user) throw Errors.unauthorized();
      await svc.update(req.params.teamId, req.params.groupId, req.user.sub, req.body);
      const detail = await svc.get(req.params.teamId, req.params.groupId);
      return reply.send(serializeDetail(detail));
    },
  });

  r.delete('/:groupId', {
    preHandler: [requirePermission('group.manage'), requireScope('admin')],
    schema: {
      tags: ['groups'],
      summary: 'Delete a user group (cascades memberships and grants only)',
      params: z.object({ teamId: z.string(), groupId: z.string() }),
      response: { 204: z.null() },
      security: [{ bearerAuth: [] }],
    },
    handler: async (req: FastifyRequest<{ Params: GroupParams }>, reply: FastifyReply) => {
      if (!req.user) throw Errors.unauthorized();
      await svc.remove(req.params.teamId, req.params.groupId, req.user.sub);
      return reply.status(204).send();
    },
  });

  r.post('/:groupId/members', {
    preHandler: [requirePermission('group.manage'), requireScope('admin')],
    schema: {
      tags: ['groups'],
      summary: 'Add team members to a group',
      params: z.object({ teamId: z.string(), groupId: z.string() }),
      body: addGroupMembersBody,
      response: { 200: userGroupDetailResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (
      req: FastifyRequest<{ Params: GroupParams; Body: AddGroupMembersBody }>,
      reply: FastifyReply,
    ) => {
      if (!req.user) throw Errors.unauthorized();
      const detail = await svc.addMembers(
        req.params.teamId,
        req.params.groupId,
        req.user.sub,
        req.body.userIds,
      );
      return reply.send(serializeDetail(detail));
    },
  });

  r.delete('/:groupId/members/:userId', {
    preHandler: [requirePermission('group.manage'), requireScope('admin')],
    schema: {
      tags: ['groups'],
      summary: 'Remove a member from a group',
      params: z.object({ teamId: z.string(), groupId: z.string(), userId: z.string() }),
      response: { 204: z.null() },
      security: [{ bearerAuth: [] }],
    },
    handler: async (req: FastifyRequest<{ Params: GroupMemberParams }>, reply: FastifyReply) => {
      if (!req.user) throw Errors.unauthorized();
      await svc.removeMember(
        req.params.teamId,
        req.params.groupId,
        req.params.userId,
        req.user.sub,
      );
      return reply.status(204).send();
    },
  });

  r.put('/:groupId/projects', {
    preHandler: [requirePermission('group.manage'), requireScope('admin')],
    schema: {
      tags: ['groups'],
      summary: 'Replace the list of projects granted to this group',
      params: z.object({ teamId: z.string(), groupId: z.string() }),
      body: setGroupProjectsBody,
      response: { 200: userGroupDetailResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (
      req: FastifyRequest<{ Params: GroupParams; Body: SetGroupProjectsBody }>,
      reply: FastifyReply,
    ) => {
      if (!req.user) throw Errors.unauthorized();
      const detail = await svc.setProjects(
        req.params.teamId,
        req.params.groupId,
        req.user.sub,
        req.body.projectIds,
      );
      return reply.send(serializeDetail(detail));
    },
  });
}

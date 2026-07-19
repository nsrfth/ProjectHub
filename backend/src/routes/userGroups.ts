import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { Errors } from '../lib/errors.js';
import { UserGroupsService, type UserGroupDetail, type UserGroupSummary } from '../services/userGroupsService.js';
import { requireAuth, requireTeamRole } from '../middleware/auth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { requireScope } from '../middleware/requireScope.js';
import {
  addGroupMemberBody,
  createUserGroupBody,
  setGroupProjectsBody,
  updateGroupMemberBody,
  updateGroupMemberRoleBody,
  type UpdateGroupMemberRoleBody,
  setMemberSubUnitBody,
  type SetMemberSubUnitBody,
  updateUserGroupBody,
  userGroupDetailResponse,
  userGroupsListResponse,
  userSearchQuery,
  userSearchResponse,
  type AddGroupMemberBody,
  type CreateUserGroupBody,
  type SetGroupProjectsBody,
  type UpdateGroupMemberBody,
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
    members: g.members.map((m) => ({
      ...m,
      invitedAt: m.invitedAt.toISOString(),
      respondedAt: m.respondedAt ? m.respondedAt.toISOString() : null,
    })),
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

  r.get('/user-search', {
    preHandler: [requirePermission('group.manage'), requireScope('admin')],
    schema: {
      tags: ['groups'],
      summary: 'Search all users (for cross-team group invites)',
      params: z.object({ teamId: z.string() }),
      querystring: userSearchQuery,
      response: { 200: userSearchResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (
      req: FastifyRequest<{ Params: TeamParams; Querystring: { q: string } }>,
      reply: FastifyReply,
    ) => {
      const items = await svc.searchUsers(req.query.q);
      return reply.send({ items });
    },
  });

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
      summary: 'Add a member (in-team direct, out-of-team invite)',
      params: z.object({ teamId: z.string(), groupId: z.string() }),
      body: addGroupMemberBody,
      response: { 200: userGroupDetailResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (
      req: FastifyRequest<{ Params: GroupParams; Body: AddGroupMemberBody }>,
      reply: FastifyReply,
    ) => {
      if (!req.user) throw Errors.unauthorized();
      const detail = await svc.addMember(
        req.params.teamId,
        req.params.groupId,
        req.user.sub,
        req.body.userId,
        req.body.accessLevel,
        req.body.role,
      );
      return reply.send(serializeDetail(detail));
    },
  });

  // v2.6 (Phase 1A): designate / demote the unit manager (group role, not
  // access level — a UNIT rejects access changes but accepts role changes).
  r.patch('/:groupId/members/:userId/role', {
    preHandler: [requirePermission('group.manage'), requireScope('admin')],
    schema: {
      tags: ['groups'],
      summary: 'Change a member role within the group (unit manager designation)',
      params: z.object({ teamId: z.string(), groupId: z.string(), userId: z.string() }),
      body: updateGroupMemberRoleBody,
      response: { 200: userGroupDetailResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (
      req: FastifyRequest<{ Params: GroupMemberParams; Body: UpdateGroupMemberRoleBody }>,
      reply: FastifyReply,
    ) => {
      if (!req.user) throw Errors.unauthorized();
      const detail = await svc.updateMemberRole(
        req.params.teamId,
        req.params.groupId,
        req.params.userId,
        req.user.sub,
        req.body.role,
      );
      return reply.send(serializeDetail(detail));
    },
  });

  // v2.16: tag a department member with a sub-unit (اداره).
  r.patch('/:groupId/members/:userId/subunit', {
    preHandler: [requirePermission('group.manage'), requireScope('admin')],
    schema: {
      tags: ['groups'],
      summary: 'Tag / untag a department member with a sub-unit',
      params: z.object({ teamId: z.string(), groupId: z.string(), userId: z.string() }),
      body: setMemberSubUnitBody,
      response: { 200: userGroupDetailResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (
      req: FastifyRequest<{ Params: GroupMemberParams; Body: SetMemberSubUnitBody }>,
      reply: FastifyReply,
    ) => {
      if (!req.user) throw Errors.unauthorized();
      const detail = await svc.setMemberSubUnit(
        req.params.teamId,
        req.params.groupId,
        req.params.userId,
        req.user.sub,
        req.body.subUnitId,
      );
      return reply.send(serializeDetail(detail));
    },
  });

  r.patch('/:groupId/members/:userId', {
    preHandler: [requirePermission('group.manage'), requireScope('admin')],
    schema: {
      tags: ['groups'],
      summary: 'Change a member access level',
      params: z.object({ teamId: z.string(), groupId: z.string(), userId: z.string() }),
      body: updateGroupMemberBody,
      response: { 200: userGroupDetailResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (
      req: FastifyRequest<{ Params: GroupMemberParams; Body: UpdateGroupMemberBody }>,
      reply: FastifyReply,
    ) => {
      if (!req.user) throw Errors.unauthorized();
      const detail = await svc.updateMemberAccess(
        req.params.teamId,
        req.params.groupId,
        req.params.userId,
        req.user.sub,
        req.body.accessLevel,
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

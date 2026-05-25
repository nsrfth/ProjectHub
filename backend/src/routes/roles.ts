import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { RolesService, type RoleView } from '../services/rolesService.js';
import { requireAuth, requireTeamRole } from '../middleware/auth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import {
  createRoleBody,
  rolesListResponse,
  roleResponse,
  setPermissionsBody,
  updateRoleBody,
  type CreateRoleBody,
  type SetPermissionsBody,
  type UpdateRoleBody,
} from '../schemas/roles.js';

// v1.23: per-team role CRUD + permission assignment. Mounted at
// /api/teams/:teamId/roles. requireTeamRole runs first (so the membership
// is on the request), then requirePermission('team.manage_roles') gates the
// actual mutations. Listing is open to any team member so the UI can show
// the role dropdown when assigning members.

function serialize(r: RoleView) {
  return {
    ...r,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

type TeamParams = { teamId: string };
type RoleParams = { teamId: string; roleId: string };

export async function rolesRoutes(app: FastifyInstance): Promise<void> {
  const svc = new RolesService();
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireTeamRole('MEMBER', 'MANAGER'));

  // List: any team member can see the role catalogue (used by the member
  // -role assignment UI). Manage-roles permission only kicks in on writes.
  r.get('/', {
    schema: {
      tags: ['roles'],
      summary: 'List roles in this team',
      params: z.object({ teamId: z.string() }),
      response: { 200: rolesListResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (req: FastifyRequest<{ Params: TeamParams }>, reply: FastifyReply) => {
      const items = await svc.list(req.params.teamId);
      return reply.send({ items: items.map(serialize) });
    },
  });

  r.get('/:roleId', {
    schema: {
      tags: ['roles'],
      summary: 'Get a role + its permissions',
      params: z.object({ teamId: z.string(), roleId: z.string() }),
      response: { 200: roleResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (req: FastifyRequest<{ Params: RoleParams }>, reply: FastifyReply) => {
      const row = await svc.get(req.params.teamId, req.params.roleId);
      return reply.send(serialize(row));
    },
  });

  r.post('/', {
    preHandler: [requirePermission('team.manage_roles')],
    schema: {
      tags: ['roles'],
      summary: 'Create a custom role',
      params: z.object({ teamId: z.string() }),
      body: createRoleBody,
      response: { 201: roleResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (
      req: FastifyRequest<{ Params: TeamParams; Body: CreateRoleBody }>,
      reply: FastifyReply,
    ) => {
      const created = await svc.create(req.params.teamId, req.body);
      return reply.status(201).send(serialize(created));
    },
  });

  r.patch('/:roleId', {
    preHandler: [requirePermission('team.manage_roles')],
    schema: {
      tags: ['roles'],
      summary: 'Update name/description on a role',
      params: z.object({ teamId: z.string(), roleId: z.string() }),
      body: updateRoleBody,
      response: { 200: roleResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (
      req: FastifyRequest<{ Params: RoleParams; Body: UpdateRoleBody }>,
      reply: FastifyReply,
    ) => {
      const updated = await svc.update(req.params.teamId, req.params.roleId, req.body);
      return reply.send(serialize(updated));
    },
  });

  r.put('/:roleId/permissions', {
    preHandler: [requirePermission('team.manage_roles')],
    schema: {
      tags: ['roles'],
      summary: 'Replace the permission set on a role (idempotent)',
      params: z.object({ teamId: z.string(), roleId: z.string() }),
      body: setPermissionsBody,
      response: { 200: roleResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (
      req: FastifyRequest<{ Params: RoleParams; Body: SetPermissionsBody }>,
      reply: FastifyReply,
    ) => {
      const updated = await svc.setPermissions(
        req.params.teamId,
        req.params.roleId,
        req.body.permissions,
      );
      return reply.send(serialize(updated));
    },
  });

  r.delete('/:roleId', {
    preHandler: [requirePermission('team.manage_roles')],
    schema: {
      tags: ['roles'],
      summary:
        'Delete a custom role. Rejects system roles and roles still assigned to memberships.',
      params: z.object({ teamId: z.string(), roleId: z.string() }),
      response: { 204: z.null() },
      security: [{ bearerAuth: [] }],
    },
    handler: async (req: FastifyRequest<{ Params: RoleParams }>, reply: FastifyReply) => {
      await svc.remove(req.params.teamId, req.params.roleId);
      return reply.status(204).send();
    },
  });
}

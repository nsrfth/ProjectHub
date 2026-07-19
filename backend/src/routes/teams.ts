import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { TeamsService } from '../services/teamsService.js';
import { OrgUnitsService } from '../services/orgUnitsService.js';
import { Errors } from '../lib/errors.js';
import { TeamsController } from '../controllers/teamsController.js';
import { requireAuth, requireTeamRole } from '../middleware/auth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { requireScope } from '../middleware/requireScope.js';
import {
  addMemberBody,
  createTeamBody,
  listTeamMembersQuery,
  memberRemovalBlockersResponse,
  teamDetailResponse,
  teamMemberResponse,
  teamMembersPage,
  teamResponse,
  teamUserSearchQuery,
  teamUserSearchResponse,
  updateMemberRoleBody,
  updateTeamBody,
  teamOrgUnitBody,
  teamOrgUnitResponse,
} from '../schemas/teams.js';

export async function teamsRoutes(app: FastifyInstance): Promise<void> {
  const svc = new TeamsService();
  const ctrl = new TeamsController(svc);
  const r = app.withTypeProvider<ZodTypeProvider>();

  // Every endpoint requires a valid bearer token. Team-role gating is layered on
  // for write operations.
  r.addHook('preHandler', requireAuth);

  r.post('/', {
    preHandler: requireScope('admin'),
    schema: {
      tags: ['teams'],
      summary: 'Create a new team — caller becomes its MANAGER',
      body: createTeamBody,
      response: { 201: teamResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.create,
  });

  r.get('/', {
    preHandler: requireScope('projects:read'),
    schema: {
      tags: ['teams'],
      summary: 'List teams the caller belongs to',
      response: { 200: z.array(teamResponse) },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.listMine,
  });

  r.get('/:teamId', {
    preHandler: requireScope('projects:read'),
    schema: {
      tags: ['teams'],
      summary: 'Get team detail (first roster page embedded for compat)',
      params: z.object({ teamId: z.string() }),
      response: { 200: teamDetailResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.getDetail,
  });

  r.get('/:teamId/members', {
    preHandler: requireScope('projects:read'),
    schema: {
      tags: ['teams'],
      summary: 'List team roster with search, filter, sort, and pagination',
      params: z.object({ teamId: z.string() }),
      querystring: listTeamMembersQuery,
      response: { 200: teamMembersPage },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.listMembers,
  });

  // v2.17: division <-> company link (portfolio attachment).
  r.get('/:teamId/org-unit', {
    preHandler: [requireTeamRole('MEMBER', 'MANAGER')],
    schema: {
      tags: ['teams'],
      summary: 'Get the company this division is attached to',
      params: z.object({ teamId: z.string() }),
      response: { 200: teamOrgUnitResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (req: FastifyRequest<{ Params: { teamId: string } }>, reply: FastifyReply) => {
      const link = await new OrgUnitsService().getTeamOrgUnit(req.params.teamId);
      return reply.send(link);
    },
  });

  r.put('/:teamId/org-unit', {
    preHandler: [
      requireTeamRole('MEMBER', 'MANAGER'),
      requirePermission('team.edit_details'),
      requireScope('admin'),
    ],
    schema: {
      tags: ['teams'],
      summary: 'Attach this division to a company from the portfolio tree',
      params: z.object({ teamId: z.string() }),
      body: teamOrgUnitBody,
      response: { 200: teamOrgUnitResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (
      req: FastifyRequest<{ Params: { teamId: string }; Body: { orgUnitId: string | null } }>,
      reply: FastifyReply,
    ) => {
      if (!req.user) throw Errors.unauthorized();
      const link = await new OrgUnitsService().setTeamOrgUnit(
        req.params.teamId,
        req.user.sub,
        req.body.orgUnitId,
      );
      return reply.send(link);
    },
  });

  r.patch('/:teamId', {
    // v1.30.8 (S-22): now gated by `team.edit_details` (v1.23
    // permission system) instead of the legacy MANAGER-only enum
    // check. requireTeamRole runs first to stash the membership for
    // the permission lookup; requirePermission enforces the specific
    // capability so a custom role can grant or withhold it.
    preHandler: [
      requireTeamRole('MEMBER', 'MANAGER'),
      requirePermission('team.edit_details'),
      requireScope('admin'),
    ],
    schema: {
      tags: ['teams'],
      summary: 'Update team name/slug/colour (requires team.edit_details)',
      params: z.object({ teamId: z.string() }),
      body: updateTeamBody,
      response: { 200: teamResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.update,
  });

  r.delete('/:teamId', {
    preHandler: [
      requireTeamRole('MEMBER', 'MANAGER'),
      requirePermission('team.delete'),
      requireScope('admin'),
    ],
    schema: {
      tags: ['teams'],
      summary: 'Delete an empty team (requires team.delete; blocks when projects/tasks exist)',
      params: z.object({ teamId: z.string() }),
      response: { 204: z.null() },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.remove,
  });

  // v1.23: membership-management endpoints now check the permission system.
  // requireTeamRole runs first (any member) so the membership is stashed on
  // the request; requirePermission then gates the specific capability.
  r.get('/:teamId/members/user-search', {
    preHandler: [
      requireTeamRole('MEMBER', 'MANAGER'),
      requirePermission('team.invite_member'),
    ],
    schema: {
      tags: ['teams'],
      summary: 'Search all users for add-member picker (requires team.invite_member)',
      params: z.object({ teamId: z.string() }),
      querystring: teamUserSearchQuery,
      response: { 200: teamUserSearchResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.searchAddableUsers,
  });

  r.post('/:teamId/members', {
    preHandler: [requireTeamRole('MEMBER', 'MANAGER'), requirePermission('team.invite_member'), requireScope('admin')],
    schema: {
      tags: ['teams'],
      summary: 'Add an existing user as a team member (requires team.invite_member)',
      params: z.object({ teamId: z.string() }),
      body: addMemberBody,
      response: { 201: teamMemberResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.addMember,
  });

  r.patch('/:teamId/members/:userId', {
    preHandler: [requireTeamRole('MEMBER', 'MANAGER'), requirePermission('team.change_role'), requireScope('admin')],
    schema: {
      tags: ['teams'],
      summary: 'Change a member role (requires team.change_role)',
      params: z.object({ teamId: z.string(), userId: z.string() }),
      body: updateMemberRoleBody,
      response: { 200: teamMemberResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.updateMemberRole,
  });

  r.get('/:teamId/members/:userId/removal-blockers', {
    preHandler: [requireTeamRole('MEMBER', 'MANAGER'), requirePermission('team.remove_member'), requireScope('admin')],
    schema: {
      tags: ['teams'],
      summary: 'List projects blocking member removal (ownership in this team)',
      params: z.object({ teamId: z.string(), userId: z.string() }),
      response: { 200: memberRemovalBlockersResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.getMemberRemovalBlockers,
  });

  r.delete('/:teamId/members/:userId', {
    preHandler: [requireTeamRole('MEMBER', 'MANAGER'), requirePermission('team.remove_member'), requireScope('admin')],
    schema: {
      tags: ['teams'],
      summary:
        'Remove a member (requires team.remove_member — last MANAGER cannot be removed; owned projects require reassign or force)',
      params: z.object({ teamId: z.string(), userId: z.string() }),
      response: { 204: z.null() },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.removeMember,
  });
}

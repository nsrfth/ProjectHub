import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { TeamsService } from '../services/teamsService.js';
import { TeamsController } from '../controllers/teamsController.js';
import { requireAuth, requireTeamRole } from '../middleware/auth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { requireScope } from '../middleware/requireScope.js';
import {
  addMemberBody,
  createTeamBody,
  teamDetailResponse,
  teamMemberResponse,
  teamResponse,
  updateMemberRoleBody,
  updateTeamBody,
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
      summary: 'Get team detail with member list (caller must be a member)',
      params: z.object({ teamId: z.string() }),
      response: { 200: teamDetailResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.getDetail,
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

  r.delete('/:teamId/members/:userId', {
    preHandler: [requireTeamRole('MEMBER', 'MANAGER'), requirePermission('team.remove_member'), requireScope('admin')],
    schema: {
      tags: ['teams'],
      summary:
        'Remove a member (requires team.remove_member — last MANAGER cannot be removed)',
      params: z.object({ teamId: z.string(), userId: z.string() }),
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.removeMember,
  });
}

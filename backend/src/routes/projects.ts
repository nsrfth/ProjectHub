import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ProjectsService } from '../services/projectsService.js';
import { ProjectsController } from '../controllers/projectsController.js';
import { requireAuth, requireTeamRole } from '../middleware/auth.js';
import { requireScope } from '../middleware/requireScope.js';
import {
  createProjectBody,
  projectCrossTeamResponse,
  projectResponse,
  updateProjectBody,
} from '../schemas/projects.js';

// Projects mount under /api/teams/:teamId/projects so requireTeamRole can
// enforce membership uniformly. Owner-or-MANAGER for mutating individual
// projects is checked one layer deeper inside the service.
export async function projectsRoutes(app: FastifyInstance): Promise<void> {
  const svc = new ProjectsService();
  const ctrl = new ProjectsController(svc);
  const r = app.withTypeProvider<ZodTypeProvider>();

  // Auth + team membership required on every endpoint. MEMBER is sufficient
  // for read; the service further restricts writes to owner-or-MANAGER.
  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireTeamRole('MEMBER', 'MANAGER'));

  r.post('/', {
    preHandler: requireScope('projects:write'),
    schema: {
      tags: ['projects'],
      summary: 'Create a project inside this team — caller becomes owner',
      params: z.object({ teamId: z.string() }),
      body: createProjectBody,
      response: { 201: projectResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.create,
  });

  r.get('/', {
    preHandler: requireScope('projects:read'),
    schema: {
      tags: ['projects'],
      summary: 'List projects in this team',
      params: z.object({ teamId: z.string() }),
      response: { 200: z.array(projectResponse) },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.list,
  });

  r.get('/:projectId', {
    preHandler: requireScope('projects:read'),
    schema: {
      tags: ['projects'],
      summary: 'Get a project (must belong to this team)',
      params: z.object({ teamId: z.string(), projectId: z.string() }),
      response: { 200: projectResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.get,
  });

  r.patch('/:projectId', {
    preHandler: requireScope('projects:write'),
    schema: {
      tags: ['projects'],
      summary: 'Update a project (owner or ADMIN: full edit; manager: rename only)',
      params: z.object({ teamId: z.string(), projectId: z.string() }),
      body: updateProjectBody,
      response: { 200: projectResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.update,
  });

  r.delete('/:projectId', {
    preHandler: requireScope('projects:write'),
    schema: {
      tags: ['projects'],
      summary: 'Delete a project (owner OR team MANAGER)',
      params: z.object({ teamId: z.string(), projectId: z.string() }),
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.remove,
  });
}

// v1.40: cross-team list mounted at /api/projects (no :teamId). The SPA's
// Projects page is now team-agnostic — it shows every project the user
// can see across the teams they belong to. Auth-only (no requireTeamRole)
// because the visibility filter inside the service already scopes by
// caller; team membership is enforced implicitly via that scope.
export async function projectsCrossTeamRoutes(app: FastifyInstance): Promise<void> {
  const svc = new ProjectsService();
  const ctrl = new ProjectsController(svc);
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);

  r.get('/', {
    preHandler: requireScope('projects:read'),
    schema: {
      tags: ['projects'],
      summary:
        'List every project the caller can see across all teams (cross-team). ' +
        'Non-ADMIN sees only projects they own; global ADMIN sees every project.',
      response: { 200: z.array(projectCrossTeamResponse) },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.listAll,
  });
}

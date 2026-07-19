import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ResourceService } from '../services/resourceService.js';
import { ResourceController } from '../controllers/resourceController.js';
import { requireAuth, requireTeamRole, requireTeamRoleOrGrantedProject } from '../middleware/auth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { requireProjectAccess, requireProjectWriteAccess } from '../middleware/requireProjectAccess.js';
import { requireModule } from '../middleware/requireModule.js';
import {
  assignmentResponse,
  createAssignmentBody,
  createResourceBody,
  createSkillBody,
  resourceResponse,
  setResourceSkillsBody,
  skillResponse,
  updateAssignmentBody,
  updateResourceBody,
  workloadQuery,
  workloadResponse,
} from '../schemas/resources.js';

// Team-scoped resource catalog + skill catalog routes.
// Prefix: /teams/:teamId/resources
export async function resourceCatalogRoutes(app: FastifyInstance): Promise<void> {
  const svc = new ResourceService();
  const ctrl = new ResourceController(svc);
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireTeamRole('MEMBER', 'MANAGER'));

  r.get('/', {
    schema: {
      tags: ['resources'],
      summary: 'List team resources',
      params: z.object({ teamId: z.string() }),
      response: { 200: z.object({ items: z.array(resourceResponse.extend({ skills: z.array(z.object({ skillId: z.string(), skillName: z.string(), level: z.number().int() })) })) }) },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.listResources,
  });

  r.get('/:resourceId', {
    schema: {
      tags: ['resources'],
      summary: 'Get a resource',
      params: z.object({ teamId: z.string(), resourceId: z.string() }),
      response: { 200: resourceResponse.extend({ skills: z.array(z.object({ skillId: z.string(), skillName: z.string(), level: z.number().int() })) }) },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.getResource,
  });

  r.post('/', {
    preHandler: [requirePermission('resource.manage')],
    schema: {
      tags: ['resources'],
      summary: 'Create a resource',
      params: z.object({ teamId: z.string() }),
      body: createResourceBody,
      response: { 201: resourceResponse.extend({ skills: z.array(z.object({ skillId: z.string(), skillName: z.string(), level: z.number().int() })) }) },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.createResource,
  });

  r.patch('/:resourceId', {
    preHandler: [requirePermission('resource.manage')],
    schema: {
      tags: ['resources'],
      summary: 'Update a resource',
      params: z.object({ teamId: z.string(), resourceId: z.string() }),
      body: updateResourceBody,
      response: { 200: resourceResponse.extend({ skills: z.array(z.object({ skillId: z.string(), skillName: z.string(), level: z.number().int() })) }) },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.updateResource,
  });

  r.delete('/:resourceId', {
    preHandler: [requirePermission('resource.manage')],
    schema: {
      tags: ['resources'],
      summary: 'Delete (soft) a resource',
      params: z.object({ teamId: z.string(), resourceId: z.string() }),
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.deleteResource,
  });

  r.put('/:resourceId/skills', {
    preHandler: [requirePermission('resource.manage')],
    schema: {
      tags: ['resources'],
      summary: 'Replace the skill set of a resource',
      params: z.object({ teamId: z.string(), resourceId: z.string() }),
      body: setResourceSkillsBody,
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.setResourceSkills,
  });

  // Workload report
  r.get('/workload', {
    schema: {
      tags: ['resources'],
      summary: 'Resource workload report (planned vs actual hours)',
      params: z.object({ teamId: z.string() }),
      querystring: workloadQuery,
      response: { 200: workloadResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.workload,
  });
}

// Team-scoped skill catalog routes. Prefix: /teams/:teamId/skills
export async function skillCatalogRoutes(app: FastifyInstance): Promise<void> {
  const svc = new ResourceService();
  const ctrl = new ResourceController(svc);
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireTeamRole('MEMBER', 'MANAGER'));

  r.get('/', {
    schema: {
      tags: ['resources'],
      summary: 'List team skills',
      params: z.object({ teamId: z.string() }),
      response: { 200: z.object({ items: z.array(skillResponse) }) },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.listSkills,
  });

  r.post('/', {
    preHandler: [requirePermission('resource.manage')],
    schema: {
      tags: ['resources'],
      summary: 'Create a skill',
      params: z.object({ teamId: z.string() }),
      body: createSkillBody,
      response: { 201: skillResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.createSkill,
  });

  r.delete('/:skillId', {
    preHandler: [requirePermission('resource.manage')],
    schema: {
      tags: ['resources'],
      summary: 'Delete a skill',
      params: z.object({ teamId: z.string(), skillId: z.string() }),
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.deleteSkill,
  });
}

// Task-scoped assignment routes.
// Prefix: /teams/:teamId/projects/:projectId/tasks/:taskId/assignments
export async function taskAssignmentRoutes(app: FastifyInstance): Promise<void> {
  const svc = new ResourceService();
  const ctrl = new ResourceController(svc);
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireTeamRoleOrGrantedProject('MEMBER', 'MANAGER'));
  r.addHook('preHandler', requireProjectAccess());
  // W1.1: project-scoped assignment routes gate under `resource_mgmt`. The
  // team-scoped resource/skill catalog + assignment-by-id routes can't use this
  // middleware (no :projectId in the path) and stay permission-gated.
  r.addHook('preHandler', requireModule('resource_mgmt'));

  r.get('/', {
    schema: {
      tags: ['resources'],
      summary: 'List resource assignments for a task',
      params: z.object({ teamId: z.string(), projectId: z.string(), taskId: z.string() }),
      response: { 200: z.object({ items: z.array(assignmentResponse) }) },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.listAssignments,
  });

  r.post('/', {
    preHandler: [requireProjectWriteAccess()],
    schema: {
      tags: ['resources'],
      summary: 'Assign a resource to a task',
      params: z.object({ teamId: z.string(), projectId: z.string(), taskId: z.string() }),
      body: createAssignmentBody,
      response: { 201: assignmentResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.createAssignment,
  });
}

// Team-scoped assignment mutation routes (update/delete by assignmentId).
// Prefix: /teams/:teamId/resource-assignments
export async function resourceAssignmentRoutes(app: FastifyInstance): Promise<void> {
  const svc = new ResourceService();
  const ctrl = new ResourceController(svc);
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireTeamRole('MEMBER', 'MANAGER'));

  r.patch('/:assignmentId', {
    // Mutations require resource.manage, matching the catalog + create paths.
    // Without it any bare team MEMBER (even one with only READ on the affected
    // project) could edit assignments.
    preHandler: [requirePermission('resource.manage')],
    schema: {
      tags: ['resources'],
      summary: 'Update a resource assignment',
      params: z.object({ teamId: z.string(), assignmentId: z.string() }),
      body: updateAssignmentBody,
      response: { 200: assignmentResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.updateAssignment,
  });

  r.delete('/:assignmentId', {
    preHandler: [requirePermission('resource.manage')],
    schema: {
      tags: ['resources'],
      summary: 'Remove a resource assignment',
      params: z.object({ teamId: z.string(), assignmentId: z.string() }),
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.deleteAssignment,
  });
}

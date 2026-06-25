import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { OrgUnitsService } from '../services/orgUnitsService.js';
import { OrgUnitsController } from '../controllers/orgUnitsController.js';
import { requireAuth, requireTeamRoleOrGrantedProject } from '../middleware/auth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { requireProjectAccess } from '../middleware/requireProjectAccess.js';
import { requireScope } from '../middleware/requireScope.js';
import {
  createOrgUnitBody,
  moveOrgUnitBody,
  orgUnitIdParams,
  orgUnitListResponse,
  orgUnitResponse,
  orgUnitTreeResponse,
  portfolioCostReport,
  portfolioEvmReport,
  portfolioProgressReport,
  portfolioRagReport,
  portfolioSummaryReport,
  setProjectOrgUnitBody,
  updateOrgUnitBody,
} from '../schemas/orgUnits.js';

const projectParams = z.object({ teamId: z.string(), projectId: z.string() });
const projectOrgUnitResponse = z.object({
  projectId: z.string(),
  orgUnitId: z.string().nullable(),
  orgUnitName: z.string().nullable(),
});

// v1.99 (PMIS R3 — portfolio / program). Two registrars:
//   /api/org-units              — global tree CRUD + subtree roll-up reports
//   /api/teams/:teamId/projects/:projectId/org-unit — attach/detach project
//
// Portfolio gating is via the R0 portfolio.* permissions (additive to RBAC).

export async function orgUnitsRoutes(app: FastifyInstance): Promise<void> {
  const ctrl = new OrgUnitsController(new OrgUnitsService());
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);

  const view = [requirePermission('portfolio.view'), requireScope('tasks:read')];
  const manage = [requirePermission('portfolio.manage'), requireScope('admin')];

  r.get('/', {
    preHandler: view,
    schema: {
      tags: ['portfolio'],
      summary: 'List all org units (flat)',
      response: { 200: orgUnitListResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.list,
  });

  r.get('/tree', {
    preHandler: view,
    schema: {
      tags: ['portfolio'],
      summary: 'List all org units as a nested tree',
      response: { 200: orgUnitTreeResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.tree,
  });

  r.post('/', {
    preHandler: manage,
    schema: {
      tags: ['portfolio'],
      summary: 'Create an org unit node',
      body: createOrgUnitBody,
      response: { 201: orgUnitResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.create,
  });

  r.get('/:orgUnitId', {
    preHandler: view,
    schema: {
      tags: ['portfolio'],
      summary: 'Get one org unit',
      params: orgUnitIdParams,
      response: { 200: orgUnitResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.get,
  });

  r.put('/:orgUnitId', {
    preHandler: manage,
    schema: {
      tags: ['portfolio'],
      summary: 'Update an org unit (name, manager, currency)',
      params: orgUnitIdParams,
      body: updateOrgUnitBody,
      response: { 200: orgUnitResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.update,
  });

  r.delete('/:orgUnitId', {
    preHandler: manage,
    schema: {
      tags: ['portfolio'],
      summary: 'Delete a leaf org unit (no children, no attached projects)',
      params: orgUnitIdParams,
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.remove,
  });

  r.post('/:orgUnitId/move', {
    preHandler: manage,
    schema: {
      tags: ['portfolio'],
      summary: 'Reparent an org unit (rewrites subtree paths)',
      params: orgUnitIdParams,
      body: moveOrgUnitBody,
      response: { 200: orgUnitResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.move,
  });

  r.get('/:orgUnitId/reports/summary', {
    preHandler: view,
    schema: {
      tags: ['portfolio'],
      summary: 'Subtree roll-up: project + task counts',
      params: orgUnitIdParams,
      response: { 200: portfolioSummaryReport },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.reportSummary,
  });

  r.get('/:orgUnitId/reports/progress', {
    preHandler: view,
    schema: {
      tags: ['portfolio'],
      summary: 'Subtree roll-up: per-project % complete',
      params: orgUnitIdParams,
      response: { 200: portfolioProgressReport },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.reportProgress,
  });

  r.get('/:orgUnitId/reports/rag', {
    preHandler: view,
    schema: {
      tags: ['portfolio'],
      summary: 'Subtree roll-up: project health (RAG) distribution',
      params: orgUnitIdParams,
      response: { 200: portfolioRagReport },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.reportRag,
  });

  r.get('/:orgUnitId/reports/cost', {
    preHandler: view,
    schema: {
      tags: ['portfolio'],
      summary: 'Subtree roll-up: planned budget by currency',
      params: orgUnitIdParams,
      response: { 200: portfolioCostReport },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.reportCost,
  });

  r.get('/:orgUnitId/reports/evm', {
    preHandler: view,
    schema: {
      tags: ['portfolio'],
      summary: 'Subtree roll-up: EVM (placeholder until R7)',
      params: orgUnitIdParams,
      response: { 200: portfolioEvmReport },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.reportEvm,
  });

  r.get('/:orgUnitId/reports/portfolio.csv', {
    preHandler: view,
    schema: {
      tags: ['portfolio'],
      summary: 'Subtree roll-up CSV export (progress columns)',
      params: orgUnitIdParams,
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.portfolioCsv,
  });
}

export async function projectOrgUnitRoutes(app: FastifyInstance): Promise<void> {
  const ctrl = new OrgUnitsController(new OrgUnitsService());
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireTeamRoleOrGrantedProject('MEMBER', 'MANAGER'));
  r.addHook('preHandler', requireProjectAccess());

  r.put('/', {
    preHandler: [requirePermission('portfolio.attach_project'), requireScope('projects:write')],
    schema: {
      tags: ['portfolio'],
      summary: 'Attach (or detach) a project to an org unit',
      params: projectParams,
      body: setProjectOrgUnitBody,
      response: { 200: projectOrgUnitResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.setProjectOrgUnit,
  });
}

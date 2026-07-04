import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { ProjectBaselinesService } from '../services/projectBaselinesService.js';
import { ProjectBaselinesController } from '../controllers/projectBaselinesController.js';
import { requireAuth, requireTeamRoleOrGrantedProject } from '../middleware/auth.js';
import { requireProjectAccess, requireProjectWriteAccess } from '../middleware/requireProjectAccess.js';
import { requireModule } from '../middleware/requireModule.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { requireScope } from '../middleware/requireScope.js';
import { z } from 'zod';
import {
  baselineCompareResponse,
  baselineIdParams,
  baselineListResponse,
  baselineResponse,
  baselineParams,
  captureBaselineBody,
} from '../schemas/projectBaselines.js';

export async function projectBaselinesRoutes(app: FastifyInstance): Promise<void> {
  const svc = new ProjectBaselinesService();
  const ctrl = new ProjectBaselinesController(svc);
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireTeamRoleOrGrantedProject('MEMBER', 'MANAGER'));
  r.addHook('preHandler', requireProjectAccess());

  // W1.1: `baselines` gates only the module-specific routes (activate + compare).
  // Capturing/listing a baseline snapshot is neutral core (ProjectBaseline landed
  // in PMIS R1), so those stay ungated — behavior preserved; this only swaps the
  // ad-hoc inline check for the shared requireModule middleware.
  r.get('/', {
    preHandler: requireScope('projects:read'),
    schema: {
      tags: ['projects'],
      summary: 'List captured schedule baselines for this project (newest first)',
      params: baselineParams,
      response: { 200: baselineListResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.list,
  });

  r.post('/', {
    preHandler: [
      requireProjectWriteAccess(),
      requirePermission('core.capture_baseline'),
      requireScope('projects:write'),
    ],
    schema: {
      tags: ['projects'],
      summary: 'Capture a new schedule baseline (also writes BaselineEntry rows)',
      params: baselineParams,
      body: captureBaselineBody,
      response: { 201: baselineResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.capture,
  });

  r.post('/:baselineId/activate', {
    preHandler: [
      requireModule('baselines'),
      requireProjectWriteAccess(),
      requirePermission('core.capture_baseline'),
      requireScope('projects:write'),
    ],
    schema: {
      tags: ['projects'],
      summary: 'Set a captured baseline as the project current baseline',
      params: baselineIdParams,
      response: { 200: baselineResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.activate,
  });

  r.get('/compare', {
    preHandler: [requireModule('baselines'), requireScope('projects:read')],
    schema: {
      tags: ['projects'],
      summary: 'Compare live task dates against a baseline (default: current)',
      params: baselineParams,
      querystring: z.object({ baselineId: z.string().optional() }),
      response: { 200: baselineCompareResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.compare,
  });
}

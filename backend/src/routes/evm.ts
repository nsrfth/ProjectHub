import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { EvmService } from '../services/evmService.js';
import { EvmController } from '../controllers/evmController.js';
import { requireAuth, requireTeamRoleOrGrantedProject } from '../middleware/auth.js';
import { requireProjectAccess, requireProjectWriteAccess } from '../middleware/requireProjectAccess.js';
import { requireModule } from '../middleware/requireModule.js';
import {
  evmMetricsResponse,
  evmQuery,
  evmSeriesQuery,
  evmSeriesResponse,
  evmSnapshotResponse,
} from '../schemas/evm.js';

// Prefix: /teams/:teamId/projects/:projectId/evm
export async function evmRoutes(app: FastifyInstance): Promise<void> {
  const svc = new EvmService();
  const ctrl = new EvmController(svc);
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireTeamRoleOrGrantedProject('MEMBER', 'MANAGER'));
  r.addHook('preHandler', requireProjectAccess());
  r.addHook('preHandler', requireModule('evm'));

  r.get('/', {
    schema: {
      tags: ['evm'],
      summary: 'Compute EVM metrics for a project (on-demand)',
      params: z.object({ teamId: z.string(), projectId: z.string() }),
      querystring: evmQuery,
      response: { 200: evmMetricsResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.compute,
  });

  r.post('/snapshot', {
    preHandler: [requireProjectWriteAccess()],
    schema: {
      tags: ['evm'],
      summary: 'Compute EVM and save a snapshot (for S-curve trending)',
      params: z.object({ teamId: z.string(), projectId: z.string() }),
      querystring: evmQuery,
      response: { 201: evmSnapshotResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.saveSnapshot,
  });

  r.get('/series', {
    schema: {
      tags: ['evm'],
      summary: 'EVM S-curve series (saved snapshots)',
      params: z.object({ teamId: z.string(), projectId: z.string() }),
      querystring: evmSeriesQuery,
      response: { 200: evmSeriesResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.series,
  });
}

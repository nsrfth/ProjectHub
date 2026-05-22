import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ReportsService } from '../services/reportsService.js';
import { ReportsController } from '../controllers/reportsController.js';
import { requireAuth, requireTeamRole } from '../middleware/auth.js';
import { doneReportResponse, doneTasksQuery } from '../schemas/reports.js';

// Team-scoped read-only reports. Mounted at /api/teams/:teamId/reports.
// More report shapes can land alongside `done` as new endpoints when the
// product surfaces a need for them.
export async function reportsRoutes(app: FastifyInstance): Promise<void> {
  const svc = new ReportsService();
  const ctrl = new ReportsController(svc);
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireTeamRole('MEMBER', 'MANAGER'));

  r.get('/done', {
    schema: {
      tags: ['reports'],
      summary: 'Tasks completed in the last N days (default 7, cap 365)',
      params: z.object({ teamId: z.string() }),
      querystring: doneTasksQuery,
      response: { 200: doneReportResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.doneTasks,
  });
}

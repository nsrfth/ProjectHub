import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ReportsService } from '../services/reportsService.js';
import { ReportsController } from '../controllers/reportsController.js';
import { requireAuth, requireTeamRole } from '../middleware/auth.js';
import {
  doneReportResponse,
  doneTasksQuery,
  overdueResponse,
  summaryResponse,
  timelinessQuery,
  timelinessResponse,
  workloadResponse,
} from '../schemas/reports.js';

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

  r.get('/workload', {
    schema: {
      tags: ['reports'],
      summary: 'Open tasks per assignee with per-status breakdown',
      params: z.object({ teamId: z.string() }),
      response: { 200: workloadResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.workload,
  });

  r.get('/overdue', {
    schema: {
      tags: ['reports'],
      summary: 'Open tasks past their dueDate, oldest first',
      params: z.object({ teamId: z.string() }),
      response: { 200: overdueResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.overdue,
  });

  r.get('/summary', {
    schema: {
      tags: ['reports'],
      summary: 'Headline counts for the dashboard widget (cheap aggregate)',
      params: z.object({ teamId: z.string() }),
      response: { 200: summaryResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.summary,
  });

  r.get('/timeliness', {
    schema: {
      tags: ['reports'],
      summary:
        'On-time rate + avg variance over tasks with both plannedDate and completedAt; plus behind-plan open-task count',
      params: z.object({ teamId: z.string() }),
      querystring: timelinessQuery,
      response: { 200: timelinessResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.timeliness,
  });

  // ── CSV exports ───────────────────────────────────────────────────────
  // Same data as the JSON endpoints above, served as text/csv with a
  // Content-Disposition that triggers a browser download. No response schema
  // declared on these — the type provider would otherwise reject the string.
  r.get('/done.csv', {
    schema: {
      tags: ['reports'],
      summary: 'CSV: tasks completed in the last N days',
      params: z.object({ teamId: z.string() }),
      querystring: doneTasksQuery,
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.doneTasksCsv,
  });

  r.get('/workload.csv', {
    schema: {
      tags: ['reports'],
      summary: 'CSV: open tasks per assignee with per-status breakdown',
      params: z.object({ teamId: z.string() }),
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.workloadCsv,
  });

  r.get('/overdue.csv', {
    schema: {
      tags: ['reports'],
      summary: 'CSV: open tasks past their dueDate',
      params: z.object({ teamId: z.string() }),
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.overdueCsv,
  });

  r.get('/timeliness.csv', {
    schema: {
      tags: ['reports'],
      summary: 'CSV: timeliness metrics as a single-row export',
      params: z.object({ teamId: z.string() }),
      querystring: timelinessQuery,
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.timelinessCsv,
  });
}

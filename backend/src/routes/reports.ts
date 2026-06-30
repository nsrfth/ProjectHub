import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ReportsService } from '../services/reportsService.js';
import { ReportsController } from '../controllers/reportsController.js';
import { requireAuth, requireTeamRole } from '../middleware/auth.js';
import { requireScope } from '../middleware/requireScope.js';
import {
  doneReportResponse,
  doneTasksQuery,
  overdueResponse,
  summaryResponse,
  teamActivityQuery,
  teamActivityResponse,
  timelinessQuery,
  timelinessResponse,
  upcomingResponse,
  upcomingTasksQuery,
  workloadResponse,
  workloadDetailQuery,
  workloadDetailResponse,
  workloadDrillQuery,
  workloadDrillResponse,
  budgetReportResponse,
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
  // v1.30.3 (S-2): all endpoints in this file are reads — gate on
  // tasks:read since reports are derived from task activity.
  r.addHook('preHandler', requireScope('tasks:read'));

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

  r.get('/workload/detail', {
    schema: {
      tags: ['reports'],
      summary:
        'Per-assignee open-task capacity: status + due-bucket split, optional project/window filter and priority weighting',
      params: z.object({ teamId: z.string() }),
      querystring: workloadDetailQuery,
      response: { 200: workloadDetailResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.workloadDetail,
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

  r.get('/upcoming', {
    schema: {
      tags: ['reports'],
      summary: "Tasks assigned to the caller with dueDate in the next N days (default 7, cap 30)",
      params: z.object({ teamId: z.string() }),
      querystring: upcomingTasksQuery,
      response: { 200: upcomingResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.upcoming,
  });

  r.get('/activity', {
    schema: {
      tags: ['reports'],
      summary: 'Team-wide activity feed (newest first, cap 100)',
      params: z.object({ teamId: z.string() }),
      querystring: teamActivityQuery,
      response: { 200: teamActivityResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.activity,
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

  r.get('/budget', {
    schema: {
      tags: ['reports'],
      summary:
        'Per-project planned vs actual spend with variance, utilization, and per-currency team rollup',
      params: z.object({ teamId: z.string() }),
      response: { 200: budgetReportResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.budgetReport,
  });

  r.get('/workload/tasks', {
    schema: {
      tags: ['reports'],
      summary: 'Task-level drill-down for a workload cell (assignee + status or due-bucket)',
      params: z.object({ teamId: z.string() }),
      querystring: workloadDrillQuery,
      response: { 200: workloadDrillResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.workloadTaskDrill,
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

  r.get('/budget.csv', {
    schema: {
      tags: ['reports'],
      summary: 'CSV: per-project budget rows with currency column',
      params: z.object({ teamId: z.string() }),
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.budgetReportCsv,
  });
}

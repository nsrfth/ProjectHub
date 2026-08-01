import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { CpmReportService, MAX_NEAR_CRITICAL_DAYS } from '../services/cpmReportService.js';
import { ProfilesService } from '../services/profilesService.js';
import { requireAuth, requireTeamRoleOrGrantedProject } from '../middleware/auth.js';
import { requireProjectAccess } from '../middleware/requireProjectAccess.js';
import { requireScope } from '../middleware/requireScope.js';
import { Errors } from '../lib/errors.js';
import { toCsv, type CsvColumn } from '../lib/csv.js';
import type { CpmReportRow } from '../services/cpmReportService.js';

// v2.23.0 (PMIS R5 supplement): CPM Schedule Analysis report.
//
// Its own endpoint rather than another `?include=` on the Gantt: the Gantt
// payload carries every subtask row in the project, which an activity-level
// schedule table has no use for. Gating, auth cascade and scope are identical
// to the Gantt report — same module (`cpm_schedule`), same `tasks:read` scope.

const floatStatus = z.enum(['NEGATIVE', 'CRITICAL', 'NEAR_CRITICAL', 'NORMAL']);

const cpmRow = z.object({
  taskId: z.string(),
  wbsCode: z.string().nullable(),
  title: z.string(),
  isMilestone: z.boolean(),
  durationDays: z.number(),
  earlyStart: z.string().nullable(),
  earlyFinish: z.string().nullable(),
  lateStart: z.string().nullable(),
  lateFinish: z.string().nullable(),
  totalFloatDays: z.number(),
  freeFloatDays: z.number(),
  floatStatus,
  drivingPredecessorId: z.string().nullable(),
});

const cpmExclusion = z.object({
  taskId: z.string(),
  title: z.string(),
  reason: z.enum(['NO_DATES', 'IS_SUMMARY', 'ORPHANED_EDGE']),
});

const cpmResponse = z.object({
  projectId: z.string(),
  scheduleVersion: z.number().int(),
  basis: z.literal('PLANNED'),
  workingDaysOnly: z.boolean(),
  nearCriticalDays: z.number().int().nonnegative(),
  summary: z.object({
    activityCount: z.number().int().nonnegative(),
    excludedCount: z.number().int().nonnegative(),
    projectStart: z.string().nullable(),
    projectFinish: z.string().nullable(),
    criticalPathDurationDays: z.number(),
    byFloatStatus: z.object({
      negative: z.number().int().nonnegative(),
      critical: z.number().int().nonnegative(),
      nearCritical: z.number().int().nonnegative(),
      normal: z.number().int().nonnegative(),
    }),
  }),
  criticalPath: z.array(z.string()),
  rows: z.array(cpmRow),
  excluded: z.array(cpmExclusion),
});

const cpmQuery = z.object({
  nearCriticalDays: z.coerce.number().int().min(0).max(MAX_NEAR_CRITICAL_DAYS).optional(),
});

const csvDay = (iso: string | null): string => (iso ? iso.slice(0, 10) : '');

export async function cpmReportRoutes(app: FastifyInstance): Promise<void> {
  const svc = new CpmReportService();
  const profiles = new ProfilesService();
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireTeamRoleOrGrantedProject('MEMBER', 'MANAGER'));
  r.addHook('preHandler', requireProjectAccess());

  async function load(
    params: { teamId: string; projectId: string },
    query: { nearCriticalDays?: number },
  ) {
    const ok = await profiles.isModuleEnabled(params.teamId, params.projectId, 'cpm_schedule');
    if (!ok) throw Errors.moduleDisabled('cpm_schedule');
    return svc.forProject(params.teamId, params.projectId, {
      nearCriticalDays: query.nearCriticalDays,
    });
  }

  r.get('/cpm', {
    preHandler: requireScope('tasks:read'),
    schema: {
      tags: ['reports'],
      summary:
        'CPM Schedule Analysis — per-activity early/late dates, total + free float, float banding, driving predecessor, and the critical path in longest-path order.',
      params: z.object({ teamId: z.string(), projectId: z.string() }),
      querystring: cpmQuery,
      response: { 200: cpmResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      const params = req.params as { teamId: string; projectId: string };
      const query = req.query as { nearCriticalDays?: number };
      if (!req.user) throw Errors.unauthorized();
      return reply.send(await load(params, query));
    },
  });

  // CSV sibling. No response schema declared — the type provider would reject
  // a string body. Matches the reports.ts `.csv` convention.
  r.get('/cpm.csv', {
    preHandler: requireScope('tasks:read'),
    schema: {
      tags: ['reports'],
      summary: 'CSV: CPM Schedule Analysis activity rows',
      params: z.object({ teamId: z.string(), projectId: z.string() }),
      querystring: cpmQuery,
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      const params = req.params as { teamId: string; projectId: string };
      const query = req.query as { nearCriticalDays?: number };
      if (!req.user) throw Errors.unauthorized();
      const report = await load(params, query);
      const titleOf = new Map(report.rows.map((x) => [x.taskId, x.title]));
      const columns: CsvColumn<CpmReportRow>[] = [
        { header: 'WBS', value: (x) => x.wbsCode },
        { header: 'Activity', value: (x) => x.title },
        { header: 'Milestone', value: (x) => (x.isMilestone ? 'yes' : 'no') },
        { header: 'Duration (d)', value: (x) => x.durationDays },
        { header: 'Early Start', value: (x) => csvDay(x.earlyStart) },
        { header: 'Early Finish', value: (x) => csvDay(x.earlyFinish) },
        { header: 'Late Start', value: (x) => csvDay(x.lateStart) },
        { header: 'Late Finish', value: (x) => csvDay(x.lateFinish) },
        { header: 'Total Float (d)', value: (x) => x.totalFloatDays },
        { header: 'Free Float (d)', value: (x) => x.freeFloatDays },
        { header: 'Float Status', value: (x) => x.floatStatus },
        {
          header: 'Driving Predecessor',
          value: (x) => (x.drivingPredecessorId ? titleOf.get(x.drivingPredecessorId) ?? x.drivingPredecessorId : ''),
        },
      ];
      // Same header convention as the team report exports (reportsController
      // .sendCsv): date-stamped filename so re-downloads don't overwrite older
      // exports, and no-store because the schedule moves with every task edit.
      // toCsv emits a UTF-8 BOM so Excel renders Persian activity names.
      const stamp = new Date().toISOString().slice(0, 10);
      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="cpm-${stamp}.csv"`);
      reply.header('Cache-Control', 'no-store');
      return reply.send(toCsv(report.rows, columns));
    },
  });
}

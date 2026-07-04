import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { GanttService } from '../services/ganttService.js';
import { ProfilesService } from '../services/profilesService.js';
import { ProjectBaselinesService } from '../services/projectBaselinesService.js';
import { requireAuth, requireTeamRoleOrGrantedProject } from '../middleware/auth.js';
import { requireProjectAccess } from '../middleware/requireProjectAccess.js';
import { requireScope } from '../middleware/requireScope.js';
import { Errors } from '../lib/errors.js';

const ganttSubtaskRow = z.object({
  id: z.string(),
  taskId: z.string(),
  parentTaskTitle: z.string(),
  parentTaskStatus: z.string(),
  title: z.string(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  assigneeId: z.string().nullable(),
  assigneeName: z.string().nullable(),
  responsibleId: z.string().nullable(),
  responsibleName: z.string().nullable(),
  done: z.boolean(),
  workingDayCount: z.number().int().nullable(),
});

const cpmBlock = z.object({
  taskId: z.string(),
  earlyStart: z.string().nullable(),
  earlyFinish: z.string().nullable(),
  lateStart: z.string().nullable(),
  lateFinish: z.string().nullable(),
  totalFloatDays: z.number(),
  isCritical: z.boolean(),
});

const ganttTaskRow = z.object({
  id: z.string(),
  title: z.string(),
  startDate: z.string().nullable(),
  dueDate: z.string().nullable(),
  isMilestone: z.boolean(),
  milestoneKind: z.string().nullable(),
  cpm: cpmBlock.optional(),
  baseline: z.object({ start: z.string().nullable(), end: z.string().nullable() }).optional(),
});

const ganttLinkRow = z.object({
  id: z.string(),
  taskId: z.string(),
  dependsOnId: z.string(),
  type: z.string(),
  lag: z.number().int(),
  lagUnit: z.string(),
  calendarMode: z.string(),
  isCritical: z.boolean(),
});

const ganttResponse = z.object({
  projectId: z.string(),
  scheduleVersion: z.number().int().optional(),
  workingDaysOnly: z.boolean(),
  summary: z.object({
    totalTasks: z.number().int().nonnegative(),
    totalSubtasks: z.number().int().nonnegative(),
    scheduledSubtasks: z.number().int().nonnegative(),
    unscheduledSubtasks: z.number().int().nonnegative(),
    earliestStart: z.string().nullable(),
    latestEnd: z.string().nullable(),
  }),
  rows: z.array(ganttSubtaskRow),
  tasks: z.array(ganttTaskRow).optional(),
  links: z.array(ganttLinkRow).optional(),
  criticalChain: z.array(z.string()).optional(),
});

const ganttQuery = z.object({
  include: z.string().optional(),
});

function parseInclude(raw?: string) {
  const set = new Set((raw ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  return {
    criticalPath: set.has('criticalPath'),
    baseline: set.has('baseline'),
    milestones: set.has('milestones'),
  };
}

export async function ganttRoutes(app: FastifyInstance): Promise<void> {
  const svc = new GanttService();
  const profiles = new ProfilesService();
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireTeamRoleOrGrantedProject('MEMBER', 'MANAGER'));
  r.addHook('preHandler', requireProjectAccess());

  r.get('/', {
    preHandler: requireScope('tasks:read'),
    schema: {
      tags: ['reports'],
      summary:
        'Project Gantt report. Legacy subtask rows unchanged. Optional ?include=criticalPath,baseline,milestones for PMIS R5 schedule overlay.',
      params: z.object({ teamId: z.string(), projectId: z.string() }),
      querystring: ganttQuery,
      response: { 200: ganttResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      const params = req.params as { teamId: string; projectId: string };
      const query = req.query as { include?: string };
      if (!req.user) throw Errors.unauthorized();
      const include = parseInclude(query.include);
      if (include.criticalPath) {
        const ok = await profiles.isModuleEnabled(params.teamId, params.projectId, 'cpm_schedule');
        if (!ok) throw Errors.moduleDisabled('cpm_schedule');
      }
      if (include.baseline) {
        const ok = await profiles.isModuleEnabled(params.teamId, params.projectId, 'baselines');
        if (!ok) throw Errors.moduleDisabled('baselines');
      }
      const report = await svc.forProject(params.teamId, params.projectId, include);
      return reply.send(report);
    },
  });
}

const varianceRow = z.object({
  taskId: z.string(),
  title: z.string(),
  baselineStart: z.string().nullable(),
  baselineEnd: z.string().nullable(),
  currentStart: z.string().nullable(),
  currentEnd: z.string().nullable(),
  slipStartDays: z.number().nullable(),
  slipEndDays: z.number().nullable(),
});

const varianceResponse = z.object({
  baselineId: z.string(),
  baselineName: z.string(),
  isCurrent: z.boolean(),
  slippedCount: z.number().int(),
  onTrackCount: z.number().int(),
  rows: z.array(varianceRow),
});

// v2.1 (PMIS R5): schedule variance vs the current (or named) baseline.
export async function scheduleVarianceRoutes(app: FastifyInstance): Promise<void> {
  const svc = new ProjectBaselinesService();
  const profiles = new ProfilesService();
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireTeamRoleOrGrantedProject('MEMBER', 'MANAGER'));
  r.addHook('preHandler', requireProjectAccess());

  r.get('/', {
    preHandler: requireScope('tasks:read'),
    schema: {
      tags: ['reports'],
      summary: 'Schedule variance report — slip days vs a captured baseline',
      params: z.object({ teamId: z.string(), projectId: z.string() }),
      querystring: z.object({ baselineId: z.string().optional() }),
      response: { 200: varianceResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      const params = req.params as { teamId: string; projectId: string };
      const query = req.query as { baselineId?: string };
      if (!req.user) throw Errors.unauthorized();
      const ok = await profiles.isModuleEnabled(params.teamId, params.projectId, 'baselines');
      if (!ok) throw Errors.moduleDisabled('baselines');
      return reply.send(await svc.variance(params.teamId, params.projectId, query.baselineId));
    },
  });
}

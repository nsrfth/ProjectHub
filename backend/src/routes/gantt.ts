import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { GanttService } from '../services/ganttService.js';
import { requireAuth, requireTeamRoleOrGrantedProject } from '../middleware/auth.js';
import { requireProjectAccess } from '../middleware/requireProjectAccess.js';
import { requireScope } from '../middleware/requireScope.js';
import { Errors } from '../lib/errors.js';

// v1.42: per-project Gantt report. Mounted at
// /api/teams/:teamId/projects/:projectId/reports/gantt so the v1.39
// requireProjectAccess cascade applies (non-owners 404 before the
// service ever runs). Read-only (no writes) — uses tasks:read scope.
//
// The response shape mirrors GanttReport in ganttService.ts.

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
  technicianId: z.string().nullable(),
  technicianName: z.string().nullable(),
  done: z.boolean(),
  workingDayCount: z.number().int().nullable(),
});

const ganttResponse = z.object({
  projectId: z.string(),
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
});

export async function ganttRoutes(app: FastifyInstance): Promise<void> {
  const svc = new GanttService();
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireTeamRoleOrGrantedProject('MEMBER', 'MANAGER'));
  // v1.39 visibility cascade — non-owners 404 even via direct URL.
  r.addHook('preHandler', requireProjectAccess());

  r.get('/', {
    preHandler: requireScope('tasks:read'),
    schema: {
      tags: ['reports'],
      summary:
        'Project Gantt report — every subtask grouped by parent task plus ' +
        'cross-row summary counts (total tasks/subtasks, scheduled vs not, ' +
        'earliest start / latest end).',
      params: z.object({ teamId: z.string(), projectId: z.string() }),
      response: { 200: ganttResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      const params = req.params as { teamId: string; projectId: string };
      if (!req.user) throw Errors.unauthorized();
      const report = await svc.forProject(params.teamId, params.projectId);
      return reply.send(report);
    },
  });
}

import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { prisma } from '../data/prisma.js';
import { requireAuth, requireTeamRole } from '../middleware/auth.js';
import { requireScope } from '../middleware/requireScope.js';
import { calendarListResponse, calendarQuery } from '../schemas/calendar.js';

// v1.12: cross-project calendar feed. One endpoint per team — returns
// every task whose chosen date (due or planned) falls inside the
// [since, until) window. The calendar page renders these as task pills
// on a date grid, coloured by the team's accent.
//
// We deliberately return the WHOLE task list (not pre-bucketed by day)
// so the frontend owns the layout logic — a server-side bucket would
// have to know about the work-week vs week vs month layouts.
export async function calendarRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireTeamRole('MEMBER', 'MANAGER'));
  r.addHook('preHandler', requireScope('tasks:read'));

  r.get('/', {
    schema: {
      tags: ['calendar'],
      summary: 'Tasks across all projects in a team with a date in the window',
      params: z.object({ teamId: z.string() }),
      querystring: calendarQuery,
      response: { 200: calendarListResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      const { teamId } = req.params as { teamId: string };
      const { since, until, field } = req.query as { since: string; until: string; field: 'due' | 'planned' };
      const sinceDate = new Date(since);
      const untilDate = new Date(until);
      const dateField = field === 'planned' ? 'plannedDate' : 'dueDate';

      const team = await prisma.team.findUnique({ where: { id: teamId }, select: { color: true, name: true } });
      // Team existence + membership both already enforced by requireTeamRole.
      const teamColor = team?.color ?? null;
      const teamName = team?.name ?? '';

      const rows = await prisma.task.findMany({
        where: {
          teamId,
          [dateField]: { gte: sinceDate, lt: untilDate },
        },
        include: {
          project: { select: { id: true, name: true } },
          assignee: { select: { id: true, name: true } },
        },
        orderBy: { [dateField]: 'asc' },
      });

      return reply.send({
        items: rows.map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          priority: t.priority,
          dueDate: t.dueDate?.toISOString() ?? null,
          plannedDate: t.plannedDate?.toISOString() ?? null,
          completedAt: t.completedAt?.toISOString() ?? null,
          projectId: t.projectId,
          projectName: t.project.name,
          teamId: t.teamId,
          teamName,
          teamColor,
          assigneeId: t.assigneeId,
          assigneeName: t.assignee?.name ?? null,
        })),
      });
    },
  });
}

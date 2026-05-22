import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ReportsService } from '../services/reportsService.js';
import type { DoneTasksQuery } from '../schemas/reports.js';

type TeamParams = { teamId: string };

export class ReportsController {
  constructor(private readonly svc: ReportsService) {}

  doneTasks = async (
    req: FastifyRequest<{ Params: TeamParams; Querystring: DoneTasksQuery }>,
    reply: FastifyReply,
  ) => {
    const rows = await this.svc.listDoneTasks(req.params.teamId, req.query.days);
    return reply.send({
      windowDays: req.query.days,
      items: rows.map((r) => ({ ...r, doneAt: r.doneAt.toISOString() })),
    });
  };
}

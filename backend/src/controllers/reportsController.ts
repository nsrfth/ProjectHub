import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ReportsService } from '../services/reportsService.js';
import type {
  DoneTasksQuery,
  TeamActivityQuery,
  TimelinessQuery,
  UpcomingTasksQuery,
  WorkloadDetailQuery,
  WorkloadDrillQuery,
} from '../schemas/reports.js';
import { Errors } from '../lib/errors.js';
import { toCsv } from '../lib/csv.js';

type TeamParams = { teamId: string };

// Common headers for every CSV download. Content-Disposition: attachment
// makes the browser save instead of rendering; the filename hint includes
// today's UTC date so re-downloads don't overwrite older exports.
function sendCsv(reply: FastifyReply, filename: string, body: string): FastifyReply {
  const stamp = new Date().toISOString().slice(0, 10);
  reply.header('Content-Type', 'text/csv; charset=utf-8');
  reply.header('Content-Disposition', `attachment; filename="${filename}-${stamp}.csv"`);
  // Reports change with every task edit — never let an intermediate cache
  // serve a stale snapshot to the user who hit "Export".
  reply.header('Cache-Control', 'no-store');
  return reply.send(body);
}

export class ReportsController {
  constructor(private readonly svc: ReportsService) {}

  doneTasks = async (
    req: FastifyRequest<{ Params: TeamParams; Querystring: DoneTasksQuery }>,
    reply: FastifyReply,
  ) => {
    const rows = await this.svc.listDoneTasks(req.params.teamId, req.query.days);
    return reply.send({
      windowDays: req.query.days,
      items: rows.map((r) => ({ ...r, completedAt: r.completedAt.toISOString() })),
    });
  };

  workload = async (req: FastifyRequest<{ Params: TeamParams }>, reply: FastifyReply) => {
    const items = await this.svc.listWorkload(req.params.teamId);
    return reply.send({ items });
  };

  workloadDetail = async (
    req: FastifyRequest<{ Params: TeamParams; Querystring: WorkloadDetailQuery }>,
    reply: FastifyReply,
  ) => {
    const { projectId, window, weighted } = req.query;
    const items = await this.svc.workloadDetail(req.params.teamId, {
      projectId,
      window,
      weighted,
    });
    return reply.send({
      window: window ?? 'all',
      weighted: weighted ?? false,
      projectId: projectId ?? null,
      items,
    });
  };

  overdue = async (req: FastifyRequest<{ Params: TeamParams }>, reply: FastifyReply) => {
    const rows = await this.svc.listOverdue(req.params.teamId);
    return reply.send({
      items: rows.map((r) => ({ ...r, dueDate: r.dueDate.toISOString() })),
    });
  };

  summary = async (req: FastifyRequest<{ Params: TeamParams }>, reply: FastifyReply) => {
    const s = await this.svc.summary(req.params.teamId);
    return reply.send(s);
  };

  timeliness = async (
    req: FastifyRequest<{ Params: TeamParams; Querystring: TimelinessQuery }>,
    reply: FastifyReply,
  ) => {
    const r = await this.svc.timeliness(req.params.teamId, req.query.days);
    return reply.send(r);
  };

  // v1.31: dashboard feeds — upcoming deadlines for the calling user and the
  // team-wide activity feed. Both are read-only, gated by tasks:read.
  upcoming = async (
    req: FastifyRequest<{ Params: TeamParams; Querystring: UpcomingTasksQuery }>,
    reply: FastifyReply,
  ) => {
    if (!req.user) throw Errors.unauthorized();
    const rows = await this.svc.listUpcomingForUser(
      req.params.teamId,
      req.user.sub,
      req.query.days,
    );
    return reply.send({
      windowDays: req.query.days,
      items: rows.map((r) => ({ ...r, dueDate: r.dueDate.toISOString() })),
    });
  };

  activity = async (
    req: FastifyRequest<{ Params: TeamParams; Querystring: TeamActivityQuery }>,
    reply: FastifyReply,
  ) => {
    const rows = await this.svc.listTeamActivity(req.params.teamId, req.query.limit);
    return reply.send({
      items: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
    });
  };

  workloadTaskDrill = async (
    req: FastifyRequest<{ Params: TeamParams; Querystring: WorkloadDrillQuery }>,
    reply: FastifyReply,
  ) => {
    const { assigneeId, status, dueBucket, projectId } = req.query;
    const rows = await this.svc.workloadTaskDrill(req.params.teamId, {
      assigneeId,
      status,
      dueBucket,
      projectId,
    });
    return reply.send({
      items: rows.map((r) => ({
        ...r,
        dueDate: r.dueDate ? r.dueDate.toISOString() : null,
      })),
    });
  };

  // ── CSV exports ─────────────────────────────────────────────────────────
  // One handler per report shape. Each mirrors its JSON sibling but returns
  // text/csv. Columns are deliberately flat (no nested objects) so the file
  // opens cleanly in Excel / Sheets / Numbers.

  doneTasksCsv = async (
    req: FastifyRequest<{ Params: TeamParams; Querystring: DoneTasksQuery }>,
    reply: FastifyReply,
  ) => {
    const rows = await this.svc.listDoneTasks(req.params.teamId, req.query.days);
    const csv = toCsv(rows, [
      { header: 'task_id', value: (r) => r.taskId },
      { header: 'task_title', value: (r) => r.taskTitle },
      { header: 'project_id', value: (r) => r.projectId },
      { header: 'project_name', value: (r) => r.projectName },
      { header: 'assignee_id', value: (r) => r.assigneeId },
      { header: 'assignee_name', value: (r) => r.assigneeName },
      { header: 'completed_at', value: (r) => r.completedAt },
    ]);
    return sendCsv(reply, `tasks-done-${req.query.days}d`, csv);
  };

  workloadCsv = async (req: FastifyRequest<{ Params: TeamParams }>, reply: FastifyReply) => {
    const rows = await this.svc.listWorkload(req.params.teamId);
    const csv = toCsv(rows, [
      { header: 'assignee_id', value: (r) => r.assigneeId },
      { header: 'assignee_name', value: (r) => r.assigneeName ?? '(unassigned)' },
      { header: 'todo', value: (r) => r.byStatus.TODO },
      { header: 'in_progress', value: (r) => r.byStatus.IN_PROGRESS },
      { header: 'review', value: (r) => r.byStatus.REVIEW },
      { header: 'total', value: (r) => r.total },
    ]);
    return sendCsv(reply, 'workload', csv);
  };

  overdueCsv = async (req: FastifyRequest<{ Params: TeamParams }>, reply: FastifyReply) => {
    const rows = await this.svc.listOverdue(req.params.teamId);
    const csv = toCsv(rows, [
      { header: 'task_id', value: (r) => r.taskId },
      { header: 'task_title', value: (r) => r.taskTitle },
      { header: 'project_id', value: (r) => r.projectId },
      { header: 'project_name', value: (r) => r.projectName },
      { header: 'status', value: (r) => r.status },
      { header: 'assignee_id', value: (r) => r.assigneeId },
      { header: 'assignee_name', value: (r) => r.assigneeName },
      { header: 'due_date', value: (r) => r.dueDate },
      { header: 'days_overdue', value: (r) => r.daysOverdue },
    ]);
    return sendCsv(reply, 'overdue', csv);
  };

  timelinessCsv = async (
    req: FastifyRequest<{ Params: TeamParams; Querystring: TimelinessQuery }>,
    reply: FastifyReply,
  ) => {
    // Timeliness is a single record — emit one-row CSV with the same metrics
    // the JSON endpoint returns, rounded for human readability.
    const r = await this.svc.timeliness(req.params.teamId, req.query.days);
    const csv = toCsv([r], [
      { header: 'window_days', value: (x) => x.windowDays },
      { header: 'evaluated_count', value: (x) => x.evaluatedCount },
      { header: 'on_time_rate', value: (x) => Math.round(x.onTimeRate * 1000) / 1000 },
      { header: 'avg_variance_days', value: (x) => Math.round(x.avgVarianceDays * 100) / 100 },
      { header: 'behind_plan_count', value: (x) => x.behindPlanCount },
    ]);
    return sendCsv(reply, `timeliness-${req.query.days}d`, csv);
  };

  budgetReport = async (req: FastifyRequest<{ Params: TeamParams }>, reply: FastifyReply) => {
    const report = await this.svc.budgetReport(req.params.teamId);
    return reply.send(report);
  };

  budgetReportCsv = async (req: FastifyRequest<{ Params: TeamParams }>, reply: FastifyReply) => {
    const { projects } = await this.svc.budgetReport(req.params.teamId);
    const csv = toCsv(projects, [
      { header: 'project_id', value: (r) => r.projectId },
      { header: 'project_name', value: (r) => r.projectName },
      { header: 'currency', value: (r) => r.currency },
      { header: 'has_budget', value: (r) => r.hasBudget },
      { header: 'planned_budget', value: (r) => r.plannedBudget },
    ]);
    return sendCsv(reply, 'budget', csv);
  };
}

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { TeamMembership } from '@prisma/client';
import type { TasksService, TaskView } from '../services/tasksService.js';
import type {
  CreateTaskBody,
  ListTasksQuery,
  ReorderTaskBody,
  UpdateTaskBody,
} from '../schemas/tasks.js';
import { Errors } from '../lib/errors.js';

type ProjectParams = { teamId: string; projectId: string };
type TaskParams = { teamId: string; projectId: string; taskId: string };

// requireTeamRole stashes the resolved membership on the request so handlers
// can read the caller's role without an extra DB hit. Same helper pattern as
// projectsController.
function callerMembership(req: FastifyRequest): TeamMembership {
  const m = (req as unknown as { membership?: TeamMembership }).membership;
  if (!m) throw Errors.internal('Missing team membership context');
  return m;
}

function serialize(t: TaskView) {
  return {
    ...t,
    // v1.37: startDate joins the date-serialization list.
    startDate: t.startDate ? t.startDate.toISOString() : null,
    dueDate: t.dueDate ? t.dueDate.toISOString() : null,
    plannedDate: t.plannedDate ? t.plannedDate.toISOString() : null,
    completedAt: t.completedAt ? t.completedAt.toISOString() : null,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

export class TasksController {
  constructor(private readonly svc: TasksService) {}

  create = async (
    req: FastifyRequest<{ Params: ProjectParams; Body: CreateTaskBody }>,
    reply: FastifyReply,
  ) => {
    if (!req.user) throw Errors.unauthorized();
    const t = await this.svc.create(
      req.params.teamId,
      req.params.projectId,
      req.user.sub,
      req.user.globalRole,
      req.body,
    );
    return reply.status(201).send(serialize(t));
  };

  list = async (
    req: FastifyRequest<{ Params: ProjectParams; Querystring: ListTasksQuery }>,
    reply: FastifyReply,
  ) => {
    const items = await this.svc.list(req.params.teamId, req.params.projectId, req.query);
    return reply.send(items.map(serialize));
  };

  listResponsibleCandidates = async (
    req: FastifyRequest<{ Params: ProjectParams }>,
    reply: FastifyReply,
  ) => {
    if (!req.user) throw Errors.unauthorized();
    const items = await this.svc.listResponsibleCandidates(
      req.params.teamId,
      req.params.projectId,
      req.user.sub,
      req.user.globalRole,
    );
    return reply.send({ items });
  };

  get = async (req: FastifyRequest<{ Params: TaskParams }>, reply: FastifyReply) => {
    const t = await this.svc.get(req.params.teamId, req.params.projectId, req.params.taskId);
    return reply.send(serialize(t));
  };

  update = async (
    req: FastifyRequest<{ Params: TaskParams; Body: UpdateTaskBody }>,
    reply: FastifyReply,
  ) => {
    if (!req.user) throw Errors.unauthorized();
    const m = callerMembership(req);
    const t = await this.svc.update(
      req.params.teamId,
      req.params.projectId,
      req.params.taskId,
      req.user.sub,
      m.role,
      req.user.globalRole,
      req.body,
    );
    return reply.send(serialize(t));
  };

  reorder = async (
    req: FastifyRequest<{ Params: TaskParams; Body: ReorderTaskBody }>,
    reply: FastifyReply,
  ) => {
    if (!req.user) throw Errors.unauthorized();
    const t = await this.svc.reorder(
      req.params.teamId,
      req.params.projectId,
      req.params.taskId,
      req.user.sub,
      req.user.globalRole,
      req.body,
    );
    return reply.send(serialize(t));
  };

  remove = async (req: FastifyRequest<{ Params: TaskParams }>, reply: FastifyReply) => {
    if (!req.user) throw Errors.unauthorized();
    await this.svc.remove(
      req.params.teamId,
      req.params.projectId,
      req.params.taskId,
      req.user.sub,
      req.user.globalRole,
    );
    return reply.status(204).send();
  };
}

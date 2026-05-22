import type { FastifyReply, FastifyRequest } from 'fastify';
import type { TasksService, TaskView } from '../services/tasksService.js';
import type {
  CreateTaskBody,
  ListTasksQuery,
  UpdateTaskBody,
} from '../schemas/tasks.js';
import { Errors } from '../lib/errors.js';

type ProjectParams = { teamId: string; projectId: string };
type TaskParams = { teamId: string; projectId: string; taskId: string };

function serialize(t: TaskView) {
  return {
    ...t,
    dueDate: t.dueDate ? t.dueDate.toISOString() : null,
    doneAt: t.doneAt ? t.doneAt.toISOString() : null,
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
    const t = await this.svc.create(req.params.teamId, req.params.projectId, req.user.sub, req.body);
    return reply.status(201).send(serialize(t));
  };

  list = async (
    req: FastifyRequest<{ Params: ProjectParams; Querystring: ListTasksQuery }>,
    reply: FastifyReply,
  ) => {
    const items = await this.svc.list(req.params.teamId, req.params.projectId, req.query);
    return reply.send(items.map(serialize));
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
    const t = await this.svc.update(
      req.params.teamId,
      req.params.projectId,
      req.params.taskId,
      req.user.sub,
      req.body,
    );
    return reply.send(serialize(t));
  };

  remove = async (req: FastifyRequest<{ Params: TaskParams }>, reply: FastifyReply) => {
    if (!req.user) throw Errors.unauthorized();
    await this.svc.remove(req.params.teamId, req.params.projectId, req.params.taskId, req.user.sub);
    return reply.status(204).send();
  };
}

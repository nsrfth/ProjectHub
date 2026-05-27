import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DependenciesService, DependencyEdgeView } from '../services/dependenciesService.js';
import type { TasksService } from '../services/tasksService.js';
import type { CreateDependencyBody } from '../schemas/dependencies.js';
import { Errors } from '../lib/errors.js';

type TaskParams = { teamId: string; projectId: string; taskId: string };
type EdgeParams = TaskParams & { dependencyId: string };

function serializeEdge(e: DependencyEdgeView) {
  return { ...e, createdAt: e.createdAt.toISOString() };
}

export class DependenciesController {
  constructor(
    private readonly svc: DependenciesService,
    private readonly tasks: TasksService,
  ) {}

  // Re-uses tasks.get to verify the team→project→task chain in one shot.
  // 404 from there leaks zero information about whether the parent exists
  // in some other tenant.
  private async ensureParent(p: TaskParams): Promise<void> {
    await this.tasks.get(p.teamId, p.projectId, p.taskId);
  }

  list = async (req: FastifyRequest<{ Params: TaskParams }>, reply: FastifyReply) => {
    await this.ensureParent(req.params);
    const view = await this.svc.list(req.params.teamId, req.params.taskId);
    return reply.send({
      blockedBy: view.blockedBy.map(serializeEdge),
      blocking: view.blocking.map(serializeEdge),
      enforcement: view.enforcement,
    });
  };

  create = async (
    req: FastifyRequest<{ Params: TaskParams; Body: CreateDependencyBody }>,
    reply: FastifyReply,
  ) => {
    if (!req.user) throw Errors.unauthorized();
    await this.ensureParent(req.params);
    const edge = await this.svc.add({
      teamId: req.params.teamId,
      projectId: req.params.projectId,
      taskId: req.params.taskId,
      dependsOnId: req.body.dependsOnId,
      type: req.body.type,
      actorId: req.user.sub,
    });
    return reply.status(201).send(serializeEdge(edge));
  };

  remove = async (req: FastifyRequest<{ Params: EdgeParams }>, reply: FastifyReply) => {
    if (!req.user) throw Errors.unauthorized();
    await this.ensureParent(req.params);
    await this.svc.remove({
      teamId: req.params.teamId,
      dependencyId: req.params.dependencyId,
      actorId: req.user.sub,
    });
    return reply.status(204).send();
  };
}

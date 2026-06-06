import type { FastifyReply, FastifyRequest } from 'fastify';
import { Errors } from '../lib/errors.js';
import type { TaskTemplatesService } from '../services/taskTemplatesService.js';
import type { TasksService } from '../services/tasksService.js';
import type { RecurrenceUpsertBody } from '../schemas/recurrence.js';

type TaskParams = { teamId: string; projectId: string; taskId: string };

export class RecurrenceController {
  constructor(
    private readonly templates: TaskTemplatesService,
    private readonly tasks: TasksService,
  ) {}

  // Parent-chain check so cross-tenant probing returns 404, not the real
  // template — the team/project/task ids in the URL must agree.
  private async ensureParent(p: TaskParams): Promise<void> {
    await this.tasks.get(p.teamId, p.projectId, p.taskId);
  }

  get = async (req: FastifyRequest<{ Params: TaskParams }>, reply: FastifyReply) => {
    await this.ensureParent(req.params);
    const view = await this.templates.get(req.params.taskId);
    if (!view) return reply.code(204).send();
    return reply.send(view);
  };

  upsert = async (
    req: FastifyRequest<{ Params: TaskParams; Body: RecurrenceUpsertBody }>,
    reply: FastifyReply,
  ) => {
    await this.ensureParent(req.params);
    const view = await this.templates.upsert(req.params.taskId, req.body);
    return reply.send(view);
  };

  remove = async (req: FastifyRequest<{ Params: TaskParams }>, reply: FastifyReply) => {
    await this.ensureParent(req.params);
    await this.templates.delete(req.params.taskId);
    return reply.code(204).send();
  };

  // Manual tick — exposed for ops / tests. Spawns every due template right
  // now regardless of the background scheduler. Gated on the team-role
  // hook the parent route registers (MANAGER+).
  tickNow = async (_req: FastifyRequest, reply: FastifyReply) => {
    if (!_req.user) throw Errors.unauthorized();
    const spawned = await this.templates.spawnDue();
    return reply.send({ spawned });
  };
}

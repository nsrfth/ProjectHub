import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SubtasksService } from '../services/subtasksService.js';
import type { CreateSubtaskBody, UpdateSubtaskBody } from '../schemas/subtasks.js';

type TaskParams = { teamId: string; projectId: string; taskId: string };
type SubtaskParams = TaskParams & { subtaskId: string };

export class SubtasksController {
  constructor(private readonly svc: SubtasksService) {}

  create = async (
    req: FastifyRequest<{ Params: TaskParams; Body: CreateSubtaskBody }>,
    reply: FastifyReply,
  ) => {
    const s = await this.svc.create(req.params.teamId, req.params.projectId, req.params.taskId, req.body);
    return reply.status(201).send(s);
  };

  update = async (
    req: FastifyRequest<{ Params: SubtaskParams; Body: UpdateSubtaskBody }>,
    reply: FastifyReply,
  ) => {
    const s = await this.svc.update(
      req.params.teamId,
      req.params.projectId,
      req.params.taskId,
      req.params.subtaskId,
      req.body,
    );
    return reply.send(s);
  };

  remove = async (req: FastifyRequest<{ Params: SubtaskParams }>, reply: FastifyReply) => {
    await this.svc.remove(
      req.params.teamId,
      req.params.projectId,
      req.params.taskId,
      req.params.subtaskId,
    );
    return reply.status(204).send();
  };
}

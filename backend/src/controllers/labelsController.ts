import type { FastifyReply, FastifyRequest } from 'fastify';
import type { LabelsService } from '../services/labelsService.js';
import type { CreateLabelBody, UpdateLabelBody } from '../schemas/labels.js';

type TeamParams = { teamId: string };
type LabelParams = { teamId: string; labelId: string };
type TaskLabelParams = { teamId: string; projectId: string; taskId: string; labelId: string };
type TaskParams = { teamId: string; projectId: string; taskId: string };

export class LabelsController {
  constructor(private readonly svc: LabelsService) {}

  list = async (req: FastifyRequest<{ Params: TeamParams }>, reply: FastifyReply) => {
    const items = await this.svc.list(req.params.teamId);
    return reply.send(items);
  };

  create = async (
    req: FastifyRequest<{ Params: TeamParams; Body: CreateLabelBody }>,
    reply: FastifyReply,
  ) => {
    const label = await this.svc.create(req.params.teamId, req.body);
    return reply.status(201).send(label);
  };

  update = async (
    req: FastifyRequest<{ Params: LabelParams; Body: UpdateLabelBody }>,
    reply: FastifyReply,
  ) => {
    const label = await this.svc.update(req.params.teamId, req.params.labelId, req.body);
    return reply.send(label);
  };

  remove = async (req: FastifyRequest<{ Params: LabelParams }>, reply: FastifyReply) => {
    await this.svc.remove(req.params.teamId, req.params.labelId);
    return reply.status(204).send();
  };

  // Attach/detach: mounted under the task path so the URL is self-describing.
  attach = async (
    req: FastifyRequest<{ Params: TaskParams; Body: { labelId: string } }>,
    reply: FastifyReply,
  ) => {
    const label = await this.svc.attach(req.params.teamId, req.params.taskId, req.body.labelId);
    return reply.status(201).send(label);
  };

  detach = async (req: FastifyRequest<{ Params: TaskLabelParams }>, reply: FastifyReply) => {
    await this.svc.detach(req.params.teamId, req.params.taskId, req.params.labelId);
    return reply.status(204).send();
  };
}

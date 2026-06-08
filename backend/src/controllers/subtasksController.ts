import type { FastifyReply, FastifyRequest } from 'fastify';
import type { TeamMembership } from '@prisma/client';
import type { SubtasksService } from '../services/subtasksService.js';
import type {
  CreateSubtaskBody,
  ReorderSubtasksBody,
  UpdateSubtaskBody,
} from '../schemas/subtasks.js';
import { Errors } from '../lib/errors.js';

type TaskParams = { teamId: string; projectId: string; taskId: string };
type SubtaskParams = TaskParams & { subtaskId: string };

function callerMembership(req: FastifyRequest): TeamMembership {
  const m = (req as unknown as { membership?: TeamMembership }).membership;
  if (!m) throw Errors.internal('Missing team membership context');
  return m;
}

export class SubtasksController {
  constructor(private readonly svc: SubtasksService) {}

  create = async (
    req: FastifyRequest<{ Params: TaskParams; Body: CreateSubtaskBody }>,
    reply: FastifyReply,
  ) => {
    if (!req.user) throw Errors.unauthorized();
    const s = await this.svc.create(
      req.params.teamId,
      req.params.projectId,
      req.params.taskId,
      // v1.19: creator becomes the default technician on create.
      // v1.42: req.body.assigneeId is passed through here untouched.
      req.user.sub,
      req.body,
    );
    return reply.status(201).send(s);
  };

  update = async (
    req: FastifyRequest<{ Params: SubtaskParams; Body: UpdateSubtaskBody }>,
    reply: FastifyReply,
  ) => {
    if (!req.user) throw Errors.unauthorized();
    // v1.23: service now resolves permissions via the actorId + globalRole.
    // Membership context is still required upstream (requireTeamRole) so the
    // caller is a team member at all.
    callerMembership(req);
    const s = await this.svc.update(
      req.params.teamId,
      req.params.projectId,
      req.params.taskId,
      req.params.subtaskId,
      req.user.sub,
      req.user.globalRole,
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

  // v1.35: bulk reorder. Body must be the FULL permutation of every
  // subtaskId for the parent task; partial / mismatched lists are
  // rejected with 400.
  reorder = async (
    req: FastifyRequest<{ Params: TaskParams; Body: ReorderSubtasksBody }>,
    reply: FastifyReply,
  ) => {
    const items = await this.svc.reorder(
      req.params.teamId,
      req.params.projectId,
      req.params.taskId,
      req.body,
    );
    return reply.send({ items });
  };
}

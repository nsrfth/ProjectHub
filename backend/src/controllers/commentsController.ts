import type { FastifyReply, FastifyRequest } from 'fastify';
import type { TeamMembership } from '@prisma/client';
import type { CommentsService, CommentView } from '../services/commentsService.js';
import type { TasksService } from '../services/tasksService.js';
import type { CreateCommentBody, UpdateCommentBody } from '../schemas/comments.js';
import { Errors } from '../lib/errors.js';

type TaskParams = { teamId: string; projectId: string; taskId: string };
type CommentParams = TaskParams & { commentId: string };

function callerMembership(req: FastifyRequest): TeamMembership {
  const m = (req as unknown as { membership?: TeamMembership }).membership;
  if (!m) throw Errors.internal('Missing team membership context');
  return m;
}

function serialize(c: CommentView) {
  return {
    ...c,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

export class CommentsController {
  constructor(
    private readonly tasks: TasksService,
    private readonly svc: CommentsService,
  ) {}

  create = async (
    req: FastifyRequest<{ Params: TaskParams; Body: CreateCommentBody }>,
    reply: FastifyReply,
  ) => {
    if (!req.user) throw Errors.unauthorized();
    // Verify the task lives at exactly this team→project. 404 on mismatch.
    await this.tasks.get(req.params.teamId, req.params.projectId, req.params.taskId);
    const c = await this.svc.create(req.params.taskId, req.user.sub, req.body.body);
    return reply.status(201).send(serialize(c));
  };

  list = async (req: FastifyRequest<{ Params: TaskParams }>, reply: FastifyReply) => {
    await this.tasks.get(req.params.teamId, req.params.projectId, req.params.taskId);
    const items = await this.svc.list(req.params.taskId);
    return reply.send(items.map(serialize));
  };

  update = async (
    req: FastifyRequest<{ Params: CommentParams; Body: UpdateCommentBody }>,
    reply: FastifyReply,
  ) => {
    if (!req.user) throw Errors.unauthorized();
    await this.tasks.get(req.params.teamId, req.params.projectId, req.params.taskId);
    const c = await this.svc.update(
      req.params.taskId,
      req.params.commentId,
      req.user.sub,
      req.body.body,
    );
    return reply.send(serialize(c));
  };

  remove = async (req: FastifyRequest<{ Params: CommentParams }>, reply: FastifyReply) => {
    const m = callerMembership(req);
    await this.tasks.get(req.params.teamId, req.params.projectId, req.params.taskId);
    await this.svc.remove(req.params.taskId, req.params.commentId, m.userId, m.role);
    return reply.status(204).send();
  };
}

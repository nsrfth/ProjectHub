import type { FastifyReply, FastifyRequest } from 'fastify';
import type { TeamMembership } from '@prisma/client';
import type { ProjectsService } from '../services/projectsService.js';
import type { CreateProjectBody, UpdateProjectBody } from '../schemas/projects.js';
import { Errors } from '../lib/errors.js';

type TeamParams = { teamId: string };
type ProjectParams = { teamId: string; projectId: string };

// requireTeamRole stashes the resolved membership on the request so route
// handlers can read the caller's role without an extra DB hit.
function callerMembership(req: FastifyRequest): TeamMembership {
  const m = (req as unknown as { membership?: TeamMembership }).membership;
  if (!m) throw Errors.internal('Missing team membership context');
  return m;
}

function serialize(p: {
  id: string;
  teamId: string;
  // Nullable because admin can SetNull when deleting the owning user.
  ownerId: string | null;
  accountableId: string | null;
  accountableName: string | null;
  name: string;
  description: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    ...p,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

export class ProjectsController {
  constructor(private readonly svc: ProjectsService) {}

  create = async (
    req: FastifyRequest<{ Params: TeamParams; Body: CreateProjectBody }>,
    reply: FastifyReply,
  ) => {
    if (!req.user) throw Errors.unauthorized();
    const p = await this.svc.create(req.params.teamId, req.user.sub, req.body);
    return reply.status(201).send(serialize(p));
  };

  list = async (req: FastifyRequest<{ Params: TeamParams }>, reply: FastifyReply) => {
    if (!req.user) throw Errors.unauthorized();
    // v1.39: list is now visibility-filtered (non-ADMIN sees only their
    // own projects). Thread the caller's userId + globalRole through to
    // the service.
    const items = await this.svc.list(
      req.params.teamId,
      req.user.sub,
      req.user.globalRole,
    );
    return reply.send(items.map(serialize));
  };

  get = async (req: FastifyRequest<{ Params: ProjectParams }>, reply: FastifyReply) => {
    if (!req.user) throw Errors.unauthorized();
    // v1.39: same caller-aware lookup; non-ADMIN non-owner gets 404.
    const p = await this.svc.get(
      req.params.teamId,
      req.params.projectId,
      req.user.sub,
      req.user.globalRole,
    );
    return reply.send(serialize(p));
  };

  update = async (
    req: FastifyRequest<{ Params: ProjectParams; Body: UpdateProjectBody }>,
    reply: FastifyReply,
  ) => {
    if (!req.user) throw Errors.unauthorized();
    callerMembership(req); // ensure team-member context
    const p = await this.svc.update(
      req.params.teamId,
      req.params.projectId,
      req.user.sub,
      req.user.globalRole,
      req.body,
    );
    return reply.send(serialize(p));
  };

  remove = async (req: FastifyRequest<{ Params: ProjectParams }>, reply: FastifyReply) => {
    if (!req.user) throw Errors.unauthorized();
    callerMembership(req);
    await this.svc.remove(
      req.params.teamId,
      req.params.projectId,
      req.user.sub,
      req.user.globalRole,
    );
    return reply.status(204).send();
  };
}

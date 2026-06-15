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
  // v1.41: budget fields are already string-shaped by the service's toView.
  plannedBudget: string | null;
  budgetCurrency: string;
  startDate: string | null;
  endDate: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: p.id,
    teamId: p.teamId,
    ownerId: p.ownerId,
    accountableId: p.accountableId,
    accountableName: p.accountableName,
    name: p.name,
    description: p.description,
    status: p.status,
    plannedBudget: p.plannedBudget,
    budgetCurrency: p.budgetCurrency,
    startDate: p.startDate,
    endDate: p.endDate,
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

  // v1.40: cross-team list for the SPA's Projects page. No team param —
  // returns every project the caller can see across all teams (or every
  // project on the instance for global ADMINs). Each row carries the
  // parent team name/slug so the SPA can chip-tag without a second hit.
  listAll = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) throw Errors.unauthorized();
    const items = await this.svc.listAllVisible(req.user.sub, req.user.globalRole);
    return reply.send(
      items.map((p) => ({
        ...serialize(p),
        teamName: p.teamName,
        teamSlug: p.teamSlug,
      })),
    );
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

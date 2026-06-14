import type { FastifyReply, FastifyRequest } from 'fastify';
import type { TeamsService } from '../services/teamsService.js';
import type {
  AddMemberBody,
  CreateTeamBody,
  ListTeamMembersQuery,
  RemoveMemberBody,
  UpdateMemberRoleBody,
  UpdateTeamBody,
} from '../schemas/teams.js';
import { removeMemberBody } from '../schemas/teams.js';
import { Errors } from '../lib/errors.js';

type TeamIdParams = { teamId: string };
type TeamMemberParams = { teamId: string; userId: string };

export class TeamsController {
  constructor(private readonly svc: TeamsService) {}

  create = async (req: FastifyRequest<{ Body: CreateTeamBody }>, reply: FastifyReply) => {
    if (!req.user) throw Errors.unauthorized();
    const team = await this.svc.create(req.user.sub, req.body);
    return reply.status(201).send({ ...team, createdAt: team.createdAt.toISOString() });
  };

  listMine = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) throw Errors.unauthorized();
    const teams = await this.svc.listMine(req.user.sub, req.user.globalRole);
    return reply.send(
      teams.map((t) => ({ ...t, createdAt: t.createdAt.toISOString() })),
    );
  };

  getDetail = async (
    req: FastifyRequest<{ Params: TeamIdParams }>,
    reply: FastifyReply,
  ) => {
    if (!req.user) throw Errors.unauthorized();
    const { team, members, capabilities, deleteBlockers } = await this.svc.getDetail(
      req.user.sub,
      req.params.teamId,
      req.user.globalRole,
    );
    return reply.send({
      ...team,
      createdAt: team.createdAt.toISOString(),
      members: members.map((m) => ({ ...m, joinedAt: m.joinedAt.toISOString() })),
      capabilities,
      deleteBlockers,
    });
  };

  listMembers = async (
    req: FastifyRequest<{ Params: TeamIdParams; Querystring: ListTeamMembersQuery }>,
    reply: FastifyReply,
  ) => {
    if (!req.user) throw Errors.unauthorized();
    const q = req.query;
    const page = await this.svc.listTeamMembers(
      req.user.sub,
      req.params.teamId,
      req.user.globalRole,
      {
        page: q.page,
        pageSize: q.pageSize,
        search: q.search,
        role: q.role,
        status: q.status,
        kind: q.kind,
        sortBy: q.sortBy,
        sortDir: q.sortDir,
      },
    );
    return reply.send({
      ...page,
      items: page.items.map((m) => ({ ...m, joinedAt: m.joinedAt.toISOString() })),
    });
  };

  update = async (
    req: FastifyRequest<{ Params: TeamIdParams; Body: UpdateTeamBody }>,
    reply: FastifyReply,
  ) => {
    if (!req.user) throw Errors.unauthorized();
    const team = await this.svc.update(req.params.teamId, req.user.sub, req.body);
    return reply.send({ ...team, createdAt: team.createdAt.toISOString() });
  };

  remove = async (
    req: FastifyRequest<{ Params: TeamIdParams }>,
    reply: FastifyReply,
  ) => {
    if (!req.user) throw Errors.unauthorized();
    await this.svc.delete(req.params.teamId, req.user.sub);
    return reply.status(204).send();
  };

  addMember = async (
    req: FastifyRequest<{ Params: TeamIdParams; Body: AddMemberBody }>,
    reply: FastifyReply,
  ) => {
    const member = await this.svc.addMember(req.params.teamId, req.body);
    return reply.status(201).send({ ...member, joinedAt: member.joinedAt.toISOString() });
  };

  getMemberRemovalBlockers = async (
    req: FastifyRequest<{ Params: TeamMemberParams }>,
    reply: FastifyReply,
  ) => {
    const blockers = await this.svc.getMemberRemovalBlockers(
      req.params.teamId,
      req.params.userId,
    );
    return reply.send(blockers);
  };

  removeMember = async (
    req: FastifyRequest<{ Params: TeamMemberParams; Body?: RemoveMemberBody }>,
    reply: FastifyReply,
  ) => {
    if (!req.user) throw Errors.unauthorized();
    const parsed = removeMemberBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw Errors.badRequest('Invalid remove-member body', parsed.error.flatten());
    }
    const { reassignOwnerTo, force } = parsed.data;
    const opts =
      reassignOwnerTo || force ? { reassignOwnerTo, force } : undefined;
    await this.svc.removeMember(
      req.params.teamId,
      req.params.userId,
      opts,
      req.user.sub,
    );
    return reply.status(204).send();
  };

  updateMemberRole = async (
    req: FastifyRequest<{ Params: TeamMemberParams; Body: UpdateMemberRoleBody }>,
    reply: FastifyReply,
  ) => {
    const member = await this.svc.updateMemberRole(
      req.params.teamId,
      req.params.userId,
      req.body,
    );
    return reply.send({ ...member, joinedAt: member.joinedAt.toISOString() });
  };
}

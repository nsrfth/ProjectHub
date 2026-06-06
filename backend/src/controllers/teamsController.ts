import type { FastifyReply, FastifyRequest } from 'fastify';
import type { TeamsService } from '../services/teamsService.js';
import type {
  AddMemberBody,
  CreateTeamBody,
  UpdateMemberRoleBody,
  UpdateTeamBody,
} from '../schemas/teams.js';
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
    const teams = await this.svc.listMine(req.user.sub);
    return reply.send(
      teams.map((t) => ({ ...t, createdAt: t.createdAt.toISOString() })),
    );
  };

  getDetail = async (
    req: FastifyRequest<{ Params: TeamIdParams }>,
    reply: FastifyReply,
  ) => {
    if (!req.user) throw Errors.unauthorized();
    const { team, members } = await this.svc.getDetail(req.user.sub, req.params.teamId);
    return reply.send({
      ...team,
      createdAt: team.createdAt.toISOString(),
      members: members.map((m) => ({ ...m, joinedAt: m.joinedAt.toISOString() })),
    });
  };

  update = async (
    req: FastifyRequest<{ Params: TeamIdParams; Body: UpdateTeamBody }>,
    reply: FastifyReply,
  ) => {
    const team = await this.svc.update(req.params.teamId, req.body);
    return reply.send({ ...team, createdAt: team.createdAt.toISOString() });
  };

  addMember = async (
    req: FastifyRequest<{ Params: TeamIdParams; Body: AddMemberBody }>,
    reply: FastifyReply,
  ) => {
    const member = await this.svc.addMember(req.params.teamId, req.body);
    return reply.status(201).send({ ...member, joinedAt: member.joinedAt.toISOString() });
  };

  removeMember = async (
    req: FastifyRequest<{ Params: TeamMemberParams }>,
    reply: FastifyReply,
  ) => {
    await this.svc.removeMember(req.params.teamId, req.params.userId);
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

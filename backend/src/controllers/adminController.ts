import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AdminService, AdminUserView, AdminTeamView } from '../services/adminService.js';
import { Errors } from '../lib/errors.js';

type UserParams = { userId: string };
type TeamParams = { teamId: string };

function serializeUser(u: AdminUserView) {
  return {
    ...u,
    emailVerifiedAt: u.emailVerifiedAt ? u.emailVerifiedAt.toISOString() : null,
    createdAt: u.createdAt.toISOString(),
  };
}

function serializeTeam(t: AdminTeamView) {
  return { ...t, createdAt: t.createdAt.toISOString() };
}

export class AdminController {
  constructor(private readonly svc: AdminService) {}

  listUsers = async (req: FastifyRequest, reply: FastifyReply) => {
    const users = await this.svc.listUsers();
    return reply.send(users.map(serializeUser));
  };

  updateUserRole = async (
    req: FastifyRequest<{ Params: UserParams; Body: { globalRole: 'ADMIN' | 'MEMBER' } }>,
    reply: FastifyReply,
  ) => {
    if (!req.user) throw Errors.unauthorized();
    const updated = await this.svc.updateUserRole(req.user.sub, req.params.userId, req.body.globalRole);
    return reply.send(serializeUser(updated));
  };

  listTeams = async (req: FastifyRequest, reply: FastifyReply) => {
    const teams = await this.svc.listTeams();
    return reply.send(teams.map(serializeTeam));
  };

  deleteTeam = async (req: FastifyRequest<{ Params: TeamParams }>, reply: FastifyReply) => {
    await this.svc.deleteTeam(req.params.teamId);
    return reply.status(204).send();
  };
}

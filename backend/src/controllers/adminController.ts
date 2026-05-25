import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AdminService, AdminUserView, AdminTeamView } from '../services/adminService.js';
import type { CreateUserBody, ListQuery } from '../schemas/admin.js';
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

  listUsers = async (
    req: FastifyRequest<{ Querystring: ListQuery }>,
    reply: FastifyReply,
  ) => {
    const page = await this.svc.listUsers(req.query);
    return reply.send({ items: page.items.map(serializeUser), nextCursor: page.nextCursor });
  };

  createUser = async (
    req: FastifyRequest<{ Body: CreateUserBody }>,
    reply: FastifyReply,
  ) => {
    const result = await this.svc.createUser(req.body);
    return reply.status(201).send({
      user: serializeUser(result.user),
      generatedPassword: result.generatedPassword,
    });
  };

  updateUserRole = async (
    req: FastifyRequest<{ Params: UserParams; Body: { globalRole: 'ADMIN' | 'MEMBER' } }>,
    reply: FastifyReply,
  ) => {
    if (!req.user) throw Errors.unauthorized();
    const updated = await this.svc.updateUserRole(req.user.sub, req.params.userId, req.body.globalRole);
    return reply.send(serializeUser(updated));
  };

  listTeams = async (
    req: FastifyRequest<{ Querystring: ListQuery }>,
    reply: FastifyReply,
  ) => {
    const page = await this.svc.listTeams(req.query);
    return reply.send({ items: page.items.map(serializeTeam), nextCursor: page.nextCursor });
  };

  deleteUser = async (req: FastifyRequest<{ Params: UserParams }>, reply: FastifyReply) => {
    if (!req.user) throw Errors.unauthorized();
    await this.svc.deleteUser(req.user.sub, req.params.userId);
    return reply.status(204).send();
  };

  deleteTeam = async (req: FastifyRequest<{ Params: TeamParams }>, reply: FastifyReply) => {
    await this.svc.deleteTeam(req.params.teamId);
    return reply.status(204).send();
  };
}

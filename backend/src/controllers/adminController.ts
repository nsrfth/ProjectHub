import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AdminService, AdminUserView, AdminTeamView } from '../services/adminService.js';
import type { AuthService } from '../services/authService.js';
import type {
  AdminResetPasswordBody,
  CreateUserBody,
  ListQuery,
  ListUsersQuery,
  LdapTestAuthBody,
  SetUserDisabledBody,
  TransferDepartmentBody,
  UpdateUserProfileBody,
} from '../schemas/admin.js';
import { Errors } from '../lib/errors.js';

type UserParams = { userId: string };
type TeamParams = { teamId: string };

function serializeUser(u: AdminUserView) {
  return {
    ...u,
    emailVerifiedAt: u.emailVerifiedAt ? u.emailVerifiedAt.toISOString() : null,
    createdAt: u.createdAt.toISOString(),
    ldapSyncedAt: u.ldapSyncedAt ? u.ldapSyncedAt.toISOString() : null,
    disabledAt: u.disabledAt ? u.disabledAt.toISOString() : null,
    lockedUntil: u.lockedUntil ? u.lockedUntil.toISOString() : null,
  };
}

function serializeTeam(t: AdminTeamView) {
  return { ...t, createdAt: t.createdAt.toISOString() };
}

export class AdminController {
  constructor(
    private readonly svc: AdminService,
    private readonly auth: AuthService,
  ) {}

  listUsers = async (
    req: FastifyRequest<{ Querystring: ListUsersQuery }>,
    reply: FastifyReply,
  ) => {
    const result = await this.svc.listUsers(req.query);
    return reply.send({
      items: result.items.map(serializeUser),
      page: result.page,
      pageSize: result.pageSize,
      totalItems: result.totalItems,
      totalPages: result.totalPages,
    });
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
    if (!req.user) throw Errors.unauthorized();
    await this.svc.deleteTeam(req.params.teamId, req.user.sub);
    return reply.status(204).send();
  };

  // v1.32.0: admin-initiated password reset. Returns the generated password
  // exactly once when the caller omits one; otherwise echoes back a null so
  // the admin UI knows it was caller-supplied.
  resetUserPassword = async (
    req: FastifyRequest<{ Params: UserParams; Body: AdminResetPasswordBody }>,
    reply: FastifyReply,
  ) => {
    const { generatedPassword } = await this.svc.resetUserPassword(
      req.params.userId,
      req.body.password,
    );
    return reply.send({ generatedPassword });
  };

  refreshLdapUser = async (
    req: FastifyRequest<{ Params: UserParams }>,
    reply: FastifyReply,
  ) => {
    await this.auth.refreshLdapUserProfile(req.params.userId);
    const view = await this.svc.getUserView(req.params.userId);
    return reply.send(serializeUser(view));
  };

  testLdapUserAuth = async (
    req: FastifyRequest<{ Params: UserParams; Body: LdapTestAuthBody }>,
    reply: FastifyReply,
  ) => {
    await this.auth.testLdapUserCredentials(req.params.userId, req.body.password);
    return reply.send({ ok: true as const });
  };

  setUserDisabled = async (
    req: FastifyRequest<{ Params: UserParams; Body: SetUserDisabledBody }>,
    reply: FastifyReply,
  ) => {
    if (!req.user) throw Errors.unauthorized();
    const updated = await this.svc.setUserDisabled(
      req.user.sub,
      req.params.userId,
      req.body.disabled,
    );
    return reply.send(serializeUser(updated));
  };

  unlockUser = async (req: FastifyRequest<{ Params: UserParams }>, reply: FastifyReply) => {
    if (!req.user) throw Errors.unauthorized();
    const updated = await this.svc.unlockUser(req.user.sub, req.params.userId);
    return reply.send(serializeUser(updated));
  };

  forceLogoutUser = async (req: FastifyRequest<{ Params: UserParams }>, reply: FastifyReply) => {
    if (!req.user) throw Errors.unauthorized();
    const updated = await this.svc.forceLogoutUser(req.user.sub, req.params.userId);
    return reply.send(serializeUser(updated));
  };

  updateUserProfile = async (
    req: FastifyRequest<{ Params: UserParams; Body: UpdateUserProfileBody }>,
    reply: FastifyReply,
  ) => {
    if (!req.user) throw Errors.unauthorized();
    const updated = await this.svc.updateUserProfile(req.user.sub, req.params.userId, req.body);
    return reply.send(serializeUser(updated));
  };

  // v2.19: project ↔ department administration.
  listDepartments = async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.send(await this.svc.listDepartments());
  };

  listProjectDepartments = async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.send(await this.svc.listProjectDepartments());
  };

  transferProjectDepartment = async (
    req: FastifyRequest<{ Params: { projectId: string }; Body: TransferDepartmentBody }>,
    reply: FastifyReply,
  ) => {
    if (!req.user) throw Errors.unauthorized();
    const result = await this.svc.transferProjectDepartment(
      req.user.sub,
      req.params.projectId,
      req.body.toGroupId,
    );
    return reply.send(result);
  };
}

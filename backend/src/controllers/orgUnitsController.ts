import type { FastifyReply, FastifyRequest } from 'fastify';
import type { OrgUnitsService, PortfolioCaller } from '../services/orgUnitsService.js';
import type {
  CreateOrgUnitBody,
  MoveOrgUnitBody,
  SetProjectOrgUnitBody,
  UpdateOrgUnitBody,
} from '../schemas/orgUnits.js';
import { Errors } from '../lib/errors.js';

type OrgUnitParams = { orgUnitId: string };
type ProjectParams = { teamId: string; projectId: string };

export class OrgUnitsController {
  constructor(private readonly svc: OrgUnitsService) {}

  // v2.20.2: portfolio reads are scoped to the caller's divisions (ADMIN sees
  // all). requireAuth guarantees req.user on every route here; each handler
  // still guards it so the type narrows and an unauthenticated call 401s.
  private caller(req: FastifyRequest): PortfolioCaller {
    if (!req.user) throw Errors.unauthorized();
    return { userId: req.user.sub, globalRole: req.user.globalRole };
  }

  list = async (req: FastifyRequest, reply: FastifyReply) => {
    const items = await this.svc.listFlat(this.caller(req));
    return reply.send({ items });
  };

  tree = async (req: FastifyRequest, reply: FastifyReply) => {
    const items = await this.svc.listTree(this.caller(req));
    return reply.send({ items });
  };

  get = async (req: FastifyRequest<{ Params: OrgUnitParams }>, reply: FastifyReply) => {
    return reply.send(await this.svc.get(req.params.orgUnitId, this.caller(req)));
  };

  create = async (
    req: FastifyRequest<{ Body: CreateOrgUnitBody }>,
    reply: FastifyReply,
  ) => {
    if (!req.user) throw Errors.unauthorized();
    const created = await this.svc.create(req.user.sub, req.body);
    return reply.status(201).send(created);
  };

  update = async (
    req: FastifyRequest<{ Params: OrgUnitParams; Body: UpdateOrgUnitBody }>,
    reply: FastifyReply,
  ) => {
    if (!req.user) throw Errors.unauthorized();
    return reply.send(await this.svc.update(req.params.orgUnitId, req.user.sub, req.body));
  };

  remove = async (req: FastifyRequest<{ Params: OrgUnitParams }>, reply: FastifyReply) => {
    if (!req.user) throw Errors.unauthorized();
    await this.svc.remove(req.params.orgUnitId, req.user.sub);
    return reply.status(204).send();
  };

  move = async (
    req: FastifyRequest<{ Params: OrgUnitParams; Body: MoveOrgUnitBody }>,
    reply: FastifyReply,
  ) => {
    if (!req.user) throw Errors.unauthorized();
    return reply.send(await this.svc.move(req.params.orgUnitId, req.user.sub, req.body));
  };

  getProjectOrgUnit = async (
    req: FastifyRequest<{ Params: ProjectParams }>,
    reply: FastifyReply,
  ) => {
    if (!req.user) throw Errors.unauthorized();
    return reply.send(
      await this.svc.getProjectOrgUnit(req.params.teamId, req.params.projectId),
    );
  };

  setProjectOrgUnit = async (
    req: FastifyRequest<{ Params: ProjectParams; Body: SetProjectOrgUnitBody }>,
    reply: FastifyReply,
  ) => {
    if (!req.user) throw Errors.unauthorized();
    const view = await this.svc.setProjectOrgUnit(
      req.params.teamId,
      req.params.projectId,
      req.user.sub,
      req.body,
    );
    return reply.send(view);
  };

  reportSummary = async (req: FastifyRequest<{ Params: OrgUnitParams }>, reply: FastifyReply) => {
    return reply.send(await this.svc.reportSummary(req.params.orgUnitId, this.caller(req)));
  };

  reportProgress = async (req: FastifyRequest<{ Params: OrgUnitParams }>, reply: FastifyReply) => {
    return reply.send(await this.svc.reportProgress(req.params.orgUnitId, this.caller(req)));
  };

  reportRag = async (req: FastifyRequest<{ Params: OrgUnitParams }>, reply: FastifyReply) => {
    return reply.send(await this.svc.reportRag(req.params.orgUnitId, this.caller(req)));
  };

  reportCost = async (req: FastifyRequest<{ Params: OrgUnitParams }>, reply: FastifyReply) => {
    return reply.send(await this.svc.reportCost(req.params.orgUnitId, this.caller(req)));
  };

  reportEvm = async (req: FastifyRequest<{ Params: OrgUnitParams }>, reply: FastifyReply) => {
    return reply.send(await this.svc.reportEvm(req.params.orgUnitId, this.caller(req)));
  };

  portfolioCsv = async (req: FastifyRequest<{ Params: OrgUnitParams }>, reply: FastifyReply) => {
    const csv = await this.svc.portfolioCsv(req.params.orgUnitId, this.caller(req));
    return reply.header('Content-Type', 'text/csv; charset=utf-8').send(csv);
  };
}

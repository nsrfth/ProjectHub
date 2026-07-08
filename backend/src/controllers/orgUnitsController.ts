import type { FastifyReply, FastifyRequest } from 'fastify';
import type { OrgUnitsService } from '../services/orgUnitsService.js';
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

  list = async (_req: FastifyRequest, reply: FastifyReply) => {
    const items = await this.svc.listFlat();
    return reply.send({ items });
  };

  tree = async (_req: FastifyRequest, reply: FastifyReply) => {
    const items = await this.svc.listTree();
    return reply.send({ items });
  };

  get = async (req: FastifyRequest<{ Params: OrgUnitParams }>, reply: FastifyReply) => {
    return reply.send(await this.svc.get(req.params.orgUnitId));
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
    return reply.send(await this.svc.reportSummary(req.params.orgUnitId));
  };

  reportProgress = async (req: FastifyRequest<{ Params: OrgUnitParams }>, reply: FastifyReply) => {
    return reply.send(await this.svc.reportProgress(req.params.orgUnitId));
  };

  reportRag = async (req: FastifyRequest<{ Params: OrgUnitParams }>, reply: FastifyReply) => {
    return reply.send(await this.svc.reportRag(req.params.orgUnitId));
  };

  reportCost = async (req: FastifyRequest<{ Params: OrgUnitParams }>, reply: FastifyReply) => {
    return reply.send(await this.svc.reportCost(req.params.orgUnitId));
  };

  reportEvm = async (req: FastifyRequest<{ Params: OrgUnitParams }>, reply: FastifyReply) => {
    return reply.send(await this.svc.reportEvm(req.params.orgUnitId));
  };

  portfolioCsv = async (req: FastifyRequest<{ Params: OrgUnitParams }>, reply: FastifyReply) => {
    const csv = await this.svc.portfolioCsv(req.params.orgUnitId);
    return reply.header('Content-Type', 'text/csv; charset=utf-8').send(csv);
  };
}

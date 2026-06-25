import type { FastifyReply, FastifyRequest } from 'fastify';
import type { TimesheetsService } from '../services/timesheetsService.js';
import { Errors } from '../lib/errors.js';
import { hasPermission } from '../middleware/requirePermission.js';
import type {
  CreateRateCardBody,
  CreateTimeEntryBody,
  BulkTimeEntryBody,
  EnsurePeriodBody,
  RejectPeriodBody,
  UpdateRateCardBody,
  UpdateTimeEntryBody,
} from '../schemas/timesheets.js';

type TeamParams = { teamId: string };
type RateParams = { teamId: string; rateCardId: string };
type EntryParams = { teamId: string; entryId: string };
type PeriodParams = { teamId: string; periodId: string };
type EntryQuery = { userId?: string; projectId?: string; from?: string; to?: string };
type PeriodQuery = { userId?: string };

export class TimesheetsController {
  constructor(private readonly svc: TimesheetsService) {}

  // Resolve which user's data the caller may read: self by default; others only
  // with timesheet.approve.
  private async resolveTargetUser(req: FastifyRequest, requested?: string): Promise<string> {
    const self = req.user!.sub;
    if (!requested || requested === self) return self;
    if (await hasPermission(req, 'timesheet.approve')) return requested;
    throw Errors.forbidden('You can only view your own timesheets');
  }

  listRateCards = async (req: FastifyRequest<{ Params: TeamParams }>, reply: FastifyReply) => {
    return reply.send({ items: await this.svc.listRateCards(req.params.teamId) });
  };
  createRateCard = async (req: FastifyRequest<{ Params: TeamParams; Body: CreateRateCardBody }>, reply: FastifyReply) => {
    return reply.status(201).send(await this.svc.createRateCard(req.params.teamId, req.user!.sub, req.body));
  };
  updateRateCard = async (req: FastifyRequest<{ Params: RateParams; Body: UpdateRateCardBody }>, reply: FastifyReply) => {
    return reply.send(await this.svc.updateRateCard(req.params.teamId, req.params.rateCardId, req.user!.sub, req.body));
  };
  deleteRateCard = async (req: FastifyRequest<{ Params: RateParams }>, reply: FastifyReply) => {
    await this.svc.deleteRateCard(req.params.teamId, req.params.rateCardId, req.user!.sub);
    return reply.status(204).send();
  };

  listTimeEntries = async (req: FastifyRequest<{ Params: TeamParams; Querystring: EntryQuery }>, reply: FastifyReply) => {
    const userId = await this.resolveTargetUser(req, req.query.userId);
    return reply.send({
      items: await this.svc.listTimeEntries(req.params.teamId, {
        userId,
        projectId: req.query.projectId,
        from: req.query.from,
        to: req.query.to,
      }),
    });
  };
  createTimeEntry = async (req: FastifyRequest<{ Params: TeamParams; Body: CreateTimeEntryBody }>, reply: FastifyReply) => {
    return reply.status(201).send(await this.svc.createTimeEntry(req.params.teamId, req.user!.sub, req.body));
  };
  bulkTimeEntries = async (req: FastifyRequest<{ Params: TeamParams; Body: BulkTimeEntryBody }>, reply: FastifyReply) => {
    return reply.status(201).send({ items: await this.svc.bulkCreate(req.params.teamId, req.user!.sub, req.body.entries) });
  };
  updateTimeEntry = async (req: FastifyRequest<{ Params: EntryParams; Body: UpdateTimeEntryBody }>, reply: FastifyReply) => {
    return reply.send(await this.svc.updateTimeEntry(req.params.teamId, req.params.entryId, req.user!.sub, req.body));
  };
  deleteTimeEntry = async (req: FastifyRequest<{ Params: EntryParams }>, reply: FastifyReply) => {
    await this.svc.deleteTimeEntry(req.params.teamId, req.params.entryId, req.user!.sub);
    return reply.status(204).send();
  };

  listPeriods = async (req: FastifyRequest<{ Params: TeamParams; Querystring: PeriodQuery }>, reply: FastifyReply) => {
    const userId = await this.resolveTargetUser(req, req.query.userId);
    return reply.send({ items: await this.svc.listPeriods(req.params.teamId, { userId }) });
  };
  ensurePeriod = async (req: FastifyRequest<{ Params: TeamParams; Body: EnsurePeriodBody }>, reply: FastifyReply) => {
    return reply.status(201).send(await this.svc.ensurePeriod(req.params.teamId, req.user!.sub, req.body));
  };
  submitPeriod = async (req: FastifyRequest<{ Params: PeriodParams }>, reply: FastifyReply) => {
    return reply.send(await this.svc.submitPeriod(req.params.teamId, req.params.periodId, req.user!.sub));
  };
  approvePeriod = async (req: FastifyRequest<{ Params: PeriodParams }>, reply: FastifyReply) => {
    return reply.send(await this.svc.approvePeriod(req.params.teamId, req.params.periodId, req.user!.sub));
  };
  rejectPeriod = async (req: FastifyRequest<{ Params: PeriodParams; Body: RejectPeriodBody }>, reply: FastifyReply) => {
    return reply.send(await this.svc.rejectPeriod(req.params.teamId, req.params.periodId, req.user!.sub, req.body.reason));
  };
  reopenPeriod = async (req: FastifyRequest<{ Params: PeriodParams }>, reply: FastifyReply) => {
    return reply.send(await this.svc.reopenPeriod(req.params.teamId, req.params.periodId, req.user!.sub));
  };
}

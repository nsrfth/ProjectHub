import type { FastifyReply, FastifyRequest } from 'fastify';
import type { CostService } from '../services/costService.js';
import type {
  CreateActualCostBody,
  CreateBudgetLineBody,
  CreateCommitmentBody,
  CreateCostAccountBody,
  CreateExpenseBody,
  CreateFxRateBody,
  UpdateCommitmentStatusBody,
  UpdateCostAccountBody,
} from '../schemas/cost.js';

type PP = { teamId: string; projectId: string };
type PPId = { teamId: string; projectId: string; id: string };
type TeamParams = { teamId: string };

export class CostController {
  constructor(private readonly svc: CostService) {}

  listAccounts = async (req: FastifyRequest<{ Params: PP }>, reply: FastifyReply) =>
    reply.send({ items: await this.svc.listCostAccounts(req.params.teamId, req.params.projectId) });
  createAccount = async (req: FastifyRequest<{ Params: PP; Body: CreateCostAccountBody }>, reply: FastifyReply) =>
    reply.status(201).send(await this.svc.createCostAccount(req.params.teamId, req.params.projectId, req.user!.sub, req.body));
  updateAccount = async (req: FastifyRequest<{ Params: PPId; Body: UpdateCostAccountBody }>, reply: FastifyReply) =>
    reply.send(await this.svc.updateCostAccount(req.params.teamId, req.params.projectId, req.params.id, req.user!.sub, req.body));
  deleteAccount = async (req: FastifyRequest<{ Params: PPId }>, reply: FastifyReply) => {
    await this.svc.deleteCostAccount(req.params.teamId, req.params.projectId, req.params.id, req.user!.sub);
    return reply.status(204).send();
  };

  listBudgetLines = async (req: FastifyRequest<{ Params: PP }>, reply: FastifyReply) =>
    reply.send({ items: await this.svc.listBudgetLines(req.params.teamId, req.params.projectId) });
  createBudgetLine = async (req: FastifyRequest<{ Params: PP; Body: CreateBudgetLineBody }>, reply: FastifyReply) =>
    reply.status(201).send(await this.svc.createBudgetLine(req.params.teamId, req.params.projectId, req.user!.sub, req.body));
  deleteBudgetLine = async (req: FastifyRequest<{ Params: PPId }>, reply: FastifyReply) => {
    await this.svc.deleteBudgetLine(req.params.teamId, req.params.projectId, req.params.id, req.user!.sub);
    return reply.status(204).send();
  };

  listCommitments = async (req: FastifyRequest<{ Params: PP }>, reply: FastifyReply) =>
    reply.send({ items: await this.svc.listCommitments(req.params.teamId, req.params.projectId) });
  createCommitment = async (req: FastifyRequest<{ Params: PP; Body: CreateCommitmentBody }>, reply: FastifyReply) =>
    reply.status(201).send(await this.svc.createCommitment(req.params.teamId, req.params.projectId, req.user!.sub, req.body));
  setCommitmentStatus = async (req: FastifyRequest<{ Params: PPId; Body: UpdateCommitmentStatusBody }>, reply: FastifyReply) =>
    reply.send(await this.svc.setCommitmentStatus(req.params.teamId, req.params.projectId, req.params.id, req.user!.sub, req.body.status));

  listExpenses = async (req: FastifyRequest<{ Params: PP }>, reply: FastifyReply) =>
    reply.send({ items: await this.svc.listExpenses(req.params.teamId, req.params.projectId) });
  createExpense = async (req: FastifyRequest<{ Params: PP; Body: CreateExpenseBody }>, reply: FastifyReply) =>
    reply.status(201).send(await this.svc.createExpense(req.params.teamId, req.params.projectId, req.user!.sub, req.body));
  approveExpense = async (req: FastifyRequest<{ Params: PPId }>, reply: FastifyReply) =>
    reply.send(await this.svc.decideExpense(req.params.teamId, req.params.projectId, req.params.id, req.user!.sub, 'APPROVED'));
  rejectExpense = async (req: FastifyRequest<{ Params: PPId }>, reply: FastifyReply) =>
    reply.send(await this.svc.decideExpense(req.params.teamId, req.params.projectId, req.params.id, req.user!.sub, 'REJECTED'));

  listActuals = async (req: FastifyRequest<{ Params: PP }>, reply: FastifyReply) =>
    reply.send({ items: await this.svc.listActuals(req.params.teamId, req.params.projectId) });
  createActual = async (req: FastifyRequest<{ Params: PP; Body: CreateActualCostBody }>, reply: FastifyReply) =>
    reply.status(201).send(await this.svc.createManualActual(req.params.teamId, req.params.projectId, req.user!.sub, req.body));
  reverseActual = async (req: FastifyRequest<{ Params: PPId }>, reply: FastifyReply) =>
    reply.status(201).send(await this.svc.reverseActual(req.params.teamId, req.params.projectId, req.params.id, req.user!.sub));

  summary = async (req: FastifyRequest<{ Params: PP }>, reply: FastifyReply) =>
    reply.send(await this.svc.projectCostSummary(req.params.teamId, req.params.projectId));

  listFxRates = async (_req: FastifyRequest<{ Params: TeamParams }>, reply: FastifyReply) =>
    reply.send({ items: await this.svc.listFxRates() });
  createFxRate = async (req: FastifyRequest<{ Params: TeamParams; Body: CreateFxRateBody }>, reply: FastifyReply) =>
    reply.status(201).send(await this.svc.createFxRate(req.user!.sub, req.body));
}

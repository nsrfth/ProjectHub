import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { CostService } from '../services/costService.js';
import { CostController } from '../controllers/costController.js';
import { requireAuth, requireTeamRole, requireTeamRoleOrGrantedProject } from '../middleware/auth.js';
import { requireProjectAccess, requireProjectWriteAccess } from '../middleware/requireProjectAccess.js';
import { requireModule } from '../middleware/requireModule.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { requireScope } from '../middleware/requireScope.js';
import {
  actualCostEntryListResponse,
  actualCostEntryResponse,
  budgetLineListResponse,
  budgetLineResponse,
  commitmentListResponse,
  commitmentResponse,
  costAccountListResponse,
  costAccountResponse,
  createActualCostBody,
  createBudgetLineBody,
  createCommitmentBody,
  createCostAccountBody,
  createExpenseBody,
  createFxRateBody,
  expenseListResponse,
  expenseResponse,
  fxRateListResponse,
  fxRateResponse,
  projectCostSummaryResponse,
  updateCommitmentStatusBody,
  updateCostAccountBody,
} from '../schemas/cost.js';

const pp = z.object({ teamId: z.string(), projectId: z.string() });
const ppId = z.object({ teamId: z.string(), projectId: z.string(), id: z.string() });
const teamParams = z.object({ teamId: z.string() });

// v2.0 (PMIS R4 — cost control). Project-scoped, profile-gated by `cost_control`.
// Reads need project READ; mutations need project WRITE + `cost.manage`.
export async function costRoutes(app: FastifyInstance): Promise<void> {
  const ctrl = new CostController(new CostService());
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireTeamRoleOrGrantedProject('MEMBER', 'MANAGER'));
  r.addHook('preHandler', requireProjectAccess());
  r.addHook('preHandler', requireModule('cost_control'));

  const read = requireScope('projects:read');
  const write = [requireProjectWriteAccess(), requirePermission('cost.manage'), requireScope('projects:write')];

  // Summary (the upgraded budget view).
  r.get('/summary', {
    preHandler: read,
    schema: { tags: ['cost'], summary: 'Project cost summary: planned/committed/actual/remaining', params: pp, response: { 200: projectCostSummaryResponse }, security: [{ bearerAuth: [] }] },
    handler: ctrl.summary,
  });

  // Cost accounts (CBS).
  r.get('/accounts', { preHandler: read, schema: { tags: ['cost'], summary: 'List cost accounts (CBS)', params: pp, response: { 200: costAccountListResponse }, security: [{ bearerAuth: [] }] }, handler: ctrl.listAccounts });
  r.post('/accounts', { preHandler: write, schema: { tags: ['cost'], summary: 'Create a cost account', params: pp, body: createCostAccountBody, response: { 201: costAccountResponse }, security: [{ bearerAuth: [] }] }, handler: ctrl.createAccount });
  r.put('/accounts/:id', { preHandler: write, schema: { tags: ['cost'], summary: 'Rename a cost account', params: ppId, body: updateCostAccountBody, response: { 200: costAccountResponse }, security: [{ bearerAuth: [] }] }, handler: ctrl.updateAccount });
  r.delete('/accounts/:id', { preHandler: write, schema: { tags: ['cost'], summary: 'Delete an empty, non-default cost account', params: ppId, security: [{ bearerAuth: [] }] }, handler: ctrl.deleteAccount });

  // Budget lines (planned value).
  r.get('/budget-lines', { preHandler: read, schema: { tags: ['cost'], summary: 'List budget lines', params: pp, response: { 200: budgetLineListResponse }, security: [{ bearerAuth: [] }] }, handler: ctrl.listBudgetLines });
  r.post('/budget-lines', { preHandler: write, schema: { tags: ['cost'], summary: 'Add a budget line', params: pp, body: createBudgetLineBody, response: { 201: budgetLineResponse }, security: [{ bearerAuth: [] }] }, handler: ctrl.createBudgetLine });
  r.delete('/budget-lines/:id', { preHandler: write, schema: { tags: ['cost'], summary: 'Delete a budget line', params: ppId, security: [{ bearerAuth: [] }] }, handler: ctrl.deleteBudgetLine });

  // Commitments.
  r.get('/commitments', { preHandler: read, schema: { tags: ['cost'], summary: 'List commitments', params: pp, response: { 200: commitmentListResponse }, security: [{ bearerAuth: [] }] }, handler: ctrl.listCommitments });
  r.post('/commitments', { preHandler: write, schema: { tags: ['cost'], summary: 'Record a commitment', params: pp, body: createCommitmentBody, response: { 201: commitmentResponse }, security: [{ bearerAuth: [] }] }, handler: ctrl.createCommitment });
  r.put('/commitments/:id/status', { preHandler: write, schema: { tags: ['cost'], summary: 'Change a commitment status', params: ppId, body: updateCommitmentStatusBody, response: { 200: commitmentResponse }, security: [{ bearerAuth: [] }] }, handler: ctrl.setCommitmentStatus });

  // Expenses (approve posts an actual).
  r.get('/expenses', { preHandler: read, schema: { tags: ['cost'], summary: 'List expenses', params: pp, response: { 200: expenseListResponse }, security: [{ bearerAuth: [] }] }, handler: ctrl.listExpenses });
  r.post('/expenses', { preHandler: requireScope('projects:write'), schema: { tags: ['cost'], summary: 'Submit an expense', params: pp, body: createExpenseBody, response: { 201: expenseResponse }, security: [{ bearerAuth: [] }] }, handler: ctrl.createExpense });
  r.post('/expenses/:id/approve', { preHandler: write, schema: { tags: ['cost'], summary: 'Approve an expense (posts an actual)', params: ppId, response: { 200: expenseResponse }, security: [{ bearerAuth: [] }] }, handler: ctrl.approveExpense });
  r.post('/expenses/:id/reject', { preHandler: write, schema: { tags: ['cost'], summary: 'Reject an expense', params: ppId, response: { 200: expenseResponse }, security: [{ bearerAuth: [] }] }, handler: ctrl.rejectExpense });

  // Actual-cost ledger.
  r.get('/actuals', { preHandler: read, schema: { tags: ['cost'], summary: 'List actual-cost ledger entries', params: pp, response: { 200: actualCostEntryListResponse }, security: [{ bearerAuth: [] }] }, handler: ctrl.listActuals });
  r.post('/actuals', { preHandler: write, schema: { tags: ['cost'], summary: 'Post a manual actual-cost entry', params: pp, body: createActualCostBody, response: { 201: actualCostEntryResponse }, security: [{ bearerAuth: [] }] }, handler: ctrl.createActual });
  r.post('/actuals/:id/reverse', { preHandler: write, schema: { tags: ['cost'], summary: 'Reverse an actual-cost entry (append-only correction)', params: ppId, response: { 201: actualCostEntryResponse }, security: [{ bearerAuth: [] }] }, handler: ctrl.reverseActual });
}

// FX reference rates are global data; the management surface is team-scoped for
// convenience and gated by `cost.manage`.
export async function fxRatesRoutes(app: FastifyInstance): Promise<void> {
  const ctrl = new CostController(new CostService());
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireTeamRole('MEMBER', 'MANAGER'));

  r.get('/', {
    preHandler: [requirePermission('cost.manage'), requireScope('projects:read')],
    schema: { tags: ['cost'], summary: 'List FX reference rates', params: teamParams, response: { 200: fxRateListResponse }, security: [{ bearerAuth: [] }] },
    handler: ctrl.listFxRates,
  });
  r.post('/', {
    preHandler: [requirePermission('cost.manage'), requireScope('admin')],
    schema: { tags: ['cost'], summary: 'Set an FX reference rate (upsert by base/quote/asOf)', params: teamParams, body: createFxRateBody, response: { 201: fxRateResponse }, security: [{ bearerAuth: [] }] },
    handler: ctrl.createFxRate,
  });
}

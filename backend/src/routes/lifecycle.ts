import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { LifecycleService } from '../services/lifecycleService.js';
import { LifecycleController } from '../controllers/lifecycleController.js';
import { requireAuth, requireTeamRole, requireTeamRoleOrGrantedProject } from '../middleware/auth.js';
import { requireProjectAccess, requireProjectWriteAccess } from '../middleware/requireProjectAccess.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { requireModule } from '../middleware/requireModule.js';
import {
  changeRequestResponse,
  contractResponse,
  createChangeRequestBody,
  createContractBody,
  createNcrBody,
  createPoBody,
  createRiskBody,
  createVendorBody,
  decideChangeRequestBody,
  ncrResponse,
  poResponse,
  riskResponse,
  updateChangeRequestBody,
  updateContractBody,
  updateNcrBody,
  updatePoBody,
  updateRiskBody,
  updateVendorBody,
  vendorResponse,
} from '../schemas/lifecycle.js';

// Risk register. Prefix: /teams/:teamId/projects/:projectId/risks
export async function riskRoutes(app: FastifyInstance): Promise<void> {
  const svc = new LifecycleService();
  const ctrl = new LifecycleController(svc);
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireTeamRoleOrGrantedProject('MEMBER', 'MANAGER'));
  r.addHook('preHandler', requireProjectAccess());
  r.addHook('preHandler', requireModule('risk'));

  r.get('/', {
    schema: { tags: ['risk'], summary: 'List risks', params: z.object({ teamId: z.string(), projectId: z.string() }), response: { 200: z.object({ items: z.array(riskResponse) }) }, security: [{ bearerAuth: [] }] },
    handler: ctrl.listRisks,
  });
  r.get('/:riskId', {
    schema: { tags: ['risk'], summary: 'Get a risk', params: z.object({ teamId: z.string(), projectId: z.string(), riskId: z.string() }), response: { 200: riskResponse }, security: [{ bearerAuth: [] }] },
    handler: ctrl.getRisk,
  });
  r.post('/', {
    preHandler: [requirePermission('risk.manage')],
    schema: { tags: ['risk'], summary: 'Create a risk', params: z.object({ teamId: z.string(), projectId: z.string() }), body: createRiskBody, response: { 201: riskResponse }, security: [{ bearerAuth: [] }] },
    handler: ctrl.createRisk,
  });
  r.patch('/:riskId', {
    preHandler: [requirePermission('risk.manage')],
    schema: { tags: ['risk'], summary: 'Update a risk', params: z.object({ teamId: z.string(), projectId: z.string(), riskId: z.string() }), body: updateRiskBody, response: { 200: riskResponse }, security: [{ bearerAuth: [] }] },
    handler: ctrl.updateRisk,
  });
  r.post('/:riskId/close', {
    preHandler: [requirePermission('risk.manage')],
    schema: { tags: ['risk'], summary: 'Close a risk', params: z.object({ teamId: z.string(), projectId: z.string(), riskId: z.string() }), security: [{ bearerAuth: [] }] },
    handler: ctrl.closeRisk,
  });
  r.delete('/:riskId', {
    preHandler: [requirePermission('risk.manage')],
    schema: { tags: ['risk'], summary: 'Delete a risk', params: z.object({ teamId: z.string(), projectId: z.string(), riskId: z.string() }), security: [{ bearerAuth: [] }] },
    handler: ctrl.deleteRisk,
  });
}

// Change requests. Prefix: /teams/:teamId/projects/:projectId/change-requests
export async function changeRequestRoutes(app: FastifyInstance): Promise<void> {
  const svc = new LifecycleService();
  const ctrl = new LifecycleController(svc);
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireTeamRoleOrGrantedProject('MEMBER', 'MANAGER'));
  r.addHook('preHandler', requireProjectAccess());
  r.addHook('preHandler', requireModule('change_control'));

  r.get('/', {
    schema: { tags: ['change-control'], summary: 'List change requests', params: z.object({ teamId: z.string(), projectId: z.string() }), response: { 200: z.object({ items: z.array(changeRequestResponse) }) }, security: [{ bearerAuth: [] }] },
    handler: ctrl.listChangeRequests,
  });
  r.get('/:crId', {
    schema: { tags: ['change-control'], summary: 'Get a change request', params: z.object({ teamId: z.string(), projectId: z.string(), crId: z.string() }), response: { 200: changeRequestResponse }, security: [{ bearerAuth: [] }] },
    handler: ctrl.getChangeRequest,
  });
  r.post('/', {
    preHandler: [requirePermission('change.manage')],
    schema: { tags: ['change-control'], summary: 'Create a change request', params: z.object({ teamId: z.string(), projectId: z.string() }), body: createChangeRequestBody, response: { 201: changeRequestResponse }, security: [{ bearerAuth: [] }] },
    handler: ctrl.createChangeRequest,
  });
  r.patch('/:crId', {
    preHandler: [requirePermission('change.manage')],
    schema: { tags: ['change-control'], summary: 'Update a change request (DRAFT only)', params: z.object({ teamId: z.string(), projectId: z.string(), crId: z.string() }), body: updateChangeRequestBody, response: { 200: changeRequestResponse }, security: [{ bearerAuth: [] }] },
    handler: ctrl.updateChangeRequest,
  });
  r.post('/:crId/submit', {
    preHandler: [requirePermission('change.manage')],
    schema: { tags: ['change-control'], summary: 'Submit a change request for approval', params: z.object({ teamId: z.string(), projectId: z.string(), crId: z.string() }), response: { 200: changeRequestResponse }, security: [{ bearerAuth: [] }] },
    handler: ctrl.submitChangeRequest,
  });
  r.post('/:crId/decide', {
    preHandler: [requirePermission('change.approve')],
    schema: { tags: ['change-control'], summary: 'Approve or reject a change request', params: z.object({ teamId: z.string(), projectId: z.string(), crId: z.string() }), body: decideChangeRequestBody, response: { 200: changeRequestResponse }, security: [{ bearerAuth: [] }] },
    handler: ctrl.decideChangeRequest,
  });
  r.post('/:crId/apply', {
    preHandler: [requirePermission('change.approve')],
    schema: { tags: ['change-control'], summary: 'Apply an approved change request (captures baseline + posts cost delta)', params: z.object({ teamId: z.string(), projectId: z.string(), crId: z.string() }), response: { 200: changeRequestResponse }, security: [{ bearerAuth: [] }] },
    handler: ctrl.applyChangeRequest,
  });
  r.delete('/:crId', {
    preHandler: [requirePermission('change.manage')],
    schema: { tags: ['change-control'], summary: 'Delete a DRAFT or REJECTED change request', params: z.object({ teamId: z.string(), projectId: z.string(), crId: z.string() }), security: [{ bearerAuth: [] }] },
    handler: ctrl.deleteChangeRequest,
  });
}

// Vendor master. Prefix: /teams/:teamId/vendors
export async function vendorRoutes(app: FastifyInstance): Promise<void> {
  const svc = new LifecycleService();
  const ctrl = new LifecycleController(svc);
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireTeamRole('MEMBER', 'MANAGER'));

  r.get('/', {
    schema: { tags: ['procurement'], summary: 'List vendors', params: z.object({ teamId: z.string() }), response: { 200: z.object({ items: z.array(vendorResponse) }) }, security: [{ bearerAuth: [] }] },
    handler: ctrl.listVendors,
  });
  r.post('/', {
    preHandler: [requirePermission('procurement.manage')],
    schema: { tags: ['procurement'], summary: 'Create a vendor', params: z.object({ teamId: z.string() }), body: createVendorBody, response: { 201: vendorResponse }, security: [{ bearerAuth: [] }] },
    handler: ctrl.createVendor,
  });
  r.patch('/:vendorId', {
    preHandler: [requirePermission('procurement.manage')],
    schema: { tags: ['procurement'], summary: 'Update a vendor', params: z.object({ teamId: z.string(), vendorId: z.string() }), body: updateVendorBody, response: { 200: vendorResponse }, security: [{ bearerAuth: [] }] },
    handler: ctrl.updateVendor,
  });
  r.delete('/:vendorId', {
    preHandler: [requirePermission('procurement.manage')],
    schema: { tags: ['procurement'], summary: 'Delete (soft) a vendor', params: z.object({ teamId: z.string(), vendorId: z.string() }), security: [{ bearerAuth: [] }] },
    handler: ctrl.deleteVendor,
  });
}

// Contracts. Prefix: /teams/:teamId/projects/:projectId/contracts
export async function contractRoutes(app: FastifyInstance): Promise<void> {
  const svc = new LifecycleService();
  const ctrl = new LifecycleController(svc);
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireTeamRoleOrGrantedProject('MEMBER', 'MANAGER'));
  r.addHook('preHandler', requireProjectAccess());
  r.addHook('preHandler', requireModule('procurement'));

  r.get('/', {
    schema: { tags: ['procurement'], summary: 'List contracts', params: z.object({ teamId: z.string(), projectId: z.string() }), response: { 200: z.object({ items: z.array(contractResponse) }) }, security: [{ bearerAuth: [] }] },
    handler: ctrl.listContracts,
  });
  r.post('/', {
    preHandler: [requireProjectWriteAccess(), requirePermission('procurement.manage')],
    schema: { tags: ['procurement'], summary: 'Create a contract', params: z.object({ teamId: z.string(), projectId: z.string() }), body: createContractBody, response: { 201: contractResponse }, security: [{ bearerAuth: [] }] },
    handler: ctrl.createContract,
  });
  r.patch('/:contractId', {
    preHandler: [requireProjectWriteAccess(), requirePermission('procurement.manage')],
    schema: { tags: ['procurement'], summary: 'Update a contract', params: z.object({ teamId: z.string(), projectId: z.string(), contractId: z.string() }), body: updateContractBody, response: { 200: contractResponse }, security: [{ bearerAuth: [] }] },
    handler: ctrl.updateContract,
  });
}

// Purchase orders. Prefix: /teams/:teamId/projects/:projectId/purchase-orders
export async function purchaseOrderRoutes(app: FastifyInstance): Promise<void> {
  const svc = new LifecycleService();
  const ctrl = new LifecycleController(svc);
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireTeamRoleOrGrantedProject('MEMBER', 'MANAGER'));
  r.addHook('preHandler', requireProjectAccess());
  r.addHook('preHandler', requireModule('procurement'));

  r.get('/', {
    schema: { tags: ['procurement'], summary: 'List purchase orders', params: z.object({ teamId: z.string(), projectId: z.string() }), response: { 200: z.object({ items: z.array(poResponse) }) }, security: [{ bearerAuth: [] }] },
    handler: ctrl.listPurchaseOrders,
  });
  r.post('/', {
    preHandler: [requireProjectWriteAccess(), requirePermission('procurement.manage')],
    schema: { tags: ['procurement'], summary: 'Create a purchase order', params: z.object({ teamId: z.string(), projectId: z.string() }), body: createPoBody, response: { 201: poResponse }, security: [{ bearerAuth: [] }] },
    handler: ctrl.createPurchaseOrder,
  });
  r.patch('/:poId', {
    preHandler: [requireProjectWriteAccess(), requirePermission('procurement.manage')],
    schema: { tags: ['procurement'], summary: 'Update a purchase order (ISSUED auto-posts Commitment)', params: z.object({ teamId: z.string(), projectId: z.string(), poId: z.string() }), body: updatePoBody, response: { 200: poResponse }, security: [{ bearerAuth: [] }] },
    handler: ctrl.updatePurchaseOrder,
  });
}

// Quality NCRs. Prefix: /teams/:teamId/projects/:projectId/ncrs
export async function ncrRoutes(app: FastifyInstance): Promise<void> {
  const svc = new LifecycleService();
  const ctrl = new LifecycleController(svc);
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireTeamRoleOrGrantedProject('MEMBER', 'MANAGER'));
  r.addHook('preHandler', requireProjectAccess());
  r.addHook('preHandler', requireModule('quality'));

  r.get('/', {
    schema: { tags: ['quality'], summary: 'List NCRs', params: z.object({ teamId: z.string(), projectId: z.string() }), response: { 200: z.object({ items: z.array(ncrResponse) }) }, security: [{ bearerAuth: [] }] },
    handler: ctrl.listNcrs,
  });
  r.post('/', {
    preHandler: [requireProjectWriteAccess(), requirePermission('quality.manage')],
    schema: { tags: ['quality'], summary: 'Create an NCR', params: z.object({ teamId: z.string(), projectId: z.string() }), body: createNcrBody, response: { 201: ncrResponse }, security: [{ bearerAuth: [] }] },
    handler: ctrl.createNcr,
  });
  r.patch('/:ncrId', {
    preHandler: [requireProjectWriteAccess(), requirePermission('quality.manage')],
    schema: { tags: ['quality'], summary: 'Update an NCR', params: z.object({ teamId: z.string(), projectId: z.string(), ncrId: z.string() }), body: updateNcrBody, response: { 200: ncrResponse }, security: [{ bearerAuth: [] }] },
    handler: ctrl.updateNcr,
  });
  r.post('/:ncrId/close', {
    preHandler: [requireProjectWriteAccess(), requirePermission('quality.manage')],
    schema: { tags: ['quality'], summary: 'Close an NCR', params: z.object({ teamId: z.string(), projectId: z.string(), ncrId: z.string() }), security: [{ bearerAuth: [] }] },
    handler: ctrl.closeNcr,
  });
  r.delete('/:ncrId', {
    preHandler: [requireProjectWriteAccess(), requirePermission('quality.manage')],
    schema: { tags: ['quality'], summary: 'Delete an NCR', params: z.object({ teamId: z.string(), projectId: z.string(), ncrId: z.string() }), security: [{ bearerAuth: [] }] },
    handler: ctrl.deleteNcr,
  });
}

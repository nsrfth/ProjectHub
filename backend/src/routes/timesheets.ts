import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { TimesheetsService } from '../services/timesheetsService.js';
import { TimesheetsController } from '../controllers/timesheetsController.js';
import { requireAuth, requireTeamRole } from '../middleware/auth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { requireScope } from '../middleware/requireScope.js';
import {
  bulkTimeEntryBody,
  createRateCardBody,
  createTimeEntryBody,
  ensurePeriodBody,
  rateCardListResponse,
  rateCardResponse,
  rejectPeriodBody,
  timeEntryListResponse,
  timeEntryResponse,
  timesheetPeriodListResponse,
  timesheetPeriodResponse,
  updateRateCardBody,
  updateTimeEntryBody,
} from '../schemas/timesheets.js';

const teamParams = z.object({ teamId: z.string() });
const rateParams = z.object({ teamId: z.string(), rateCardId: z.string() });
const entryParams = z.object({ teamId: z.string(), entryId: z.string() });
const periodParams = z.object({ teamId: z.string(), periodId: z.string() });
const entryQuery = z.object({
  userId: z.string().optional(),
  projectId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});
const periodQuery = z.object({ userId: z.string().optional() });

// v2.0 (PMIS R4 — time tracking). Team-scoped (a weekly timesheet spans
// projects). The `timesheets` profile module is enforced per-entry in the
// service (the project is in the body, not the path). Logging your OWN time is
// an implicit member capability; approving others' periods needs
// `timesheet.approve`; rate-card admin needs `timesheet.manage_rates`.
export async function timesheetsRoutes(app: FastifyInstance): Promise<void> {
  const ctrl = new TimesheetsController(new TimesheetsService());
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireTeamRole('MEMBER', 'MANAGER'));

  const rates = [requirePermission('timesheet.manage_rates'), requireScope('admin')];
  const approve = [requirePermission('timesheet.approve'), requireScope('tasks:write')];

  // Rate cards.
  r.get('/rate-cards', {
    preHandler: rates,
    schema: { tags: ['timesheets'], summary: 'List rate cards', params: teamParams, response: { 200: rateCardListResponse }, security: [{ bearerAuth: [] }] },
    handler: ctrl.listRateCards,
  });
  r.post('/rate-cards', {
    preHandler: rates,
    schema: { tags: ['timesheets'], summary: 'Create a rate card', params: teamParams, body: createRateCardBody, response: { 201: rateCardResponse }, security: [{ bearerAuth: [] }] },
    handler: ctrl.createRateCard,
  });
  r.put('/rate-cards/:rateCardId', {
    preHandler: rates,
    schema: { tags: ['timesheets'], summary: 'Update a rate card', params: rateParams, body: updateRateCardBody, response: { 200: rateCardResponse }, security: [{ bearerAuth: [] }] },
    handler: ctrl.updateRateCard,
  });
  r.delete('/rate-cards/:rateCardId', {
    preHandler: rates,
    schema: { tags: ['timesheets'], summary: 'Delete a rate card', params: rateParams, security: [{ bearerAuth: [] }] },
    handler: ctrl.deleteRateCard,
  });

  // Time entries (own).
  r.get('/time-entries', {
    preHandler: requireScope('tasks:read'),
    schema: { tags: ['timesheets'], summary: 'List time entries (self; others need timesheet.approve)', params: teamParams, querystring: entryQuery, response: { 200: timeEntryListResponse }, security: [{ bearerAuth: [] }] },
    handler: ctrl.listTimeEntries,
  });
  r.post('/time-entries', {
    preHandler: requireScope('tasks:write'),
    schema: { tags: ['timesheets'], summary: 'Log a time entry', params: teamParams, body: createTimeEntryBody, response: { 201: timeEntryResponse }, security: [{ bearerAuth: [] }] },
    handler: ctrl.createTimeEntry,
  });
  r.post('/time-entries/bulk', {
    preHandler: requireScope('tasks:write'),
    schema: { tags: ['timesheets'], summary: 'Log many time entries (weekly grid)', params: teamParams, body: bulkTimeEntryBody, response: { 201: timeEntryListResponse }, security: [{ bearerAuth: [] }] },
    handler: ctrl.bulkTimeEntries,
  });
  r.patch('/time-entries/:entryId', {
    preHandler: requireScope('tasks:write'),
    schema: { tags: ['timesheets'], summary: 'Edit a time entry (own, while period open)', params: entryParams, body: updateTimeEntryBody, response: { 200: timeEntryResponse }, security: [{ bearerAuth: [] }] },
    handler: ctrl.updateTimeEntry,
  });
  r.delete('/time-entries/:entryId', {
    preHandler: requireScope('tasks:write'),
    schema: { tags: ['timesheets'], summary: 'Delete a time entry (own, while period open)', params: entryParams, security: [{ bearerAuth: [] }] },
    handler: ctrl.deleteTimeEntry,
  });

  // Timesheet periods.
  r.get('/timesheets', {
    preHandler: requireScope('tasks:read'),
    schema: { tags: ['timesheets'], summary: 'List timesheet periods (self; others need timesheet.approve)', params: teamParams, querystring: periodQuery, response: { 200: timesheetPeriodListResponse }, security: [{ bearerAuth: [] }] },
    handler: ctrl.listPeriods,
  });
  r.post('/timesheets', {
    preHandler: requireScope('tasks:write'),
    schema: { tags: ['timesheets'], summary: 'Open (ensure) a timesheet period and adopt entries in range', params: teamParams, body: ensurePeriodBody, response: { 201: timesheetPeriodResponse }, security: [{ bearerAuth: [] }] },
    handler: ctrl.ensurePeriod,
  });
  r.post('/timesheets/:periodId/submit', {
    preHandler: requireScope('tasks:write'),
    schema: { tags: ['timesheets'], summary: 'Submit your timesheet period', params: periodParams, response: { 200: timesheetPeriodResponse }, security: [{ bearerAuth: [] }] },
    handler: ctrl.submitPeriod,
  });
  r.post('/timesheets/:periodId/approve', {
    preHandler: approve,
    schema: { tags: ['timesheets'], summary: 'Approve a timesheet (posts labour to the cost ledger)', params: periodParams, response: { 200: timesheetPeriodResponse }, security: [{ bearerAuth: [] }] },
    handler: ctrl.approvePeriod,
  });
  r.post('/timesheets/:periodId/reject', {
    preHandler: approve,
    schema: { tags: ['timesheets'], summary: 'Reject a submitted timesheet', params: periodParams, body: rejectPeriodBody, response: { 200: timesheetPeriodResponse }, security: [{ bearerAuth: [] }] },
    handler: ctrl.rejectPeriod,
  });
  r.post('/timesheets/:periodId/reopen', {
    preHandler: approve,
    schema: { tags: ['timesheets'], summary: 'Reopen a timesheet (reverses posted labour if it was approved)', params: periodParams, response: { 200: timesheetPeriodResponse }, security: [{ bearerAuth: [] }] },
    handler: ctrl.reopenPeriod,
  });
}

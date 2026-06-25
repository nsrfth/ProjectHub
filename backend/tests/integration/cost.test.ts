import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';

// v2.0 (PMIS R4 — cost control + time tracking): the headline loop is
// rate card -> time entry -> submit -> approve -> ActualCostEntry posted ->
// cost summary reflects actual. Plus module gating + a permission negative.

let app: FastifyInstance;

beforeAll(async () => {
  process.env.MASTER_KEY ??= '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
  app = await buildApp(loadEnv());
});
afterAll(async () => {
  if (app) await app.close();
});

beforeEach(async () => {
  await prisma.actualCostEntry.deleteMany();
  await prisma.budgetLine.deleteMany();
  await prisma.commitment.deleteMany();
  await prisma.expense.deleteMany();
  await prisma.timeEntry.deleteMany();
  await prisma.timesheetPeriod.deleteMany();
  await prisma.costAccount.deleteMany();
  await prisma.rateCard.deleteMany();
  await prisma.projectBaseline.deleteMany();
  await prisma.task.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.rolePermission.deleteMany();
  await prisma.project.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.role.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
  await prisma.instanceSetting.deleteMany();
});

const PASSWORD = 'CorrectHorseBattery9';

async function register(email: string, name = 'User') {
  const r = await bootstrapUser(app, { email, name, password: PASSWORD });
  return { token: r.token, userId: r.userId };
}
async function createTeam(token: string, slug: string): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/api/teams', headers: { authorization: `Bearer ${token}` }, payload: { name: slug, slug } });
  if (r.statusCode !== 201) throw new Error(`createTeam: ${r.statusCode} ${r.body}`);
  return r.json().id as string;
}
async function createProject(token: string, teamId: string, name: string): Promise<string> {
  const r = await app.inject({ method: 'POST', url: `/api/teams/${teamId}/projects`, headers: { authorization: `Bearer ${token}` }, payload: { name } });
  if (r.statusCode !== 201) throw new Error(`createProject: ${r.statusCode} ${r.body}`);
  return r.json().id as string;
}
async function enableModules(token: string, teamId: string, projectId: string) {
  const r = await app.inject({
    method: 'PUT',
    url: `/api/teams/${teamId}/projects/${projectId}/profile/overrides`,
    headers: { authorization: `Bearer ${token}` },
    payload: { overrides: { cost_control: { enabled: true }, timesheets: { enabled: true } } },
  });
  if (r.statusCode !== 200) throw new Error(`enableModules: ${r.statusCode} ${r.body}`);
}
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe('Cost control + time tracking (PMIS R4)', () => {
  it('gates cost endpoints behind the cost_control module', async () => {
    const a = await register('a@example.com');
    const teamId = await createTeam(a.token, 'cost-a');
    const projectId = await createProject(a.token, teamId, 'Neutral');

    const blocked = await app.inject({ method: 'GET', url: `/api/teams/${teamId}/projects/${projectId}/cost/summary`, headers: auth(a.token) });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('module_disabled');

    await enableModules(a.token, teamId, projectId);
    const ok = await app.inject({ method: 'GET', url: `/api/teams/${teamId}/projects/${projectId}/cost/summary`, headers: auth(a.token) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().reportingCurrency).toBe('IRR');
  });

  it('posts labour to the ledger on timesheet approval and reflects it in the cost summary', async () => {
    const a = await register('a@example.com');
    const teamId = await createTeam(a.token, 'cost-b');
    const projectId = await createProject(a.token, teamId, 'Build');
    await enableModules(a.token, teamId, projectId);

    // Rate: 60000 IRR/hour (IRR has 0 decimals, so minor == rial).
    const rate = await app.inject({
      method: 'POST',
      url: `/api/teams/${teamId}/rate-cards`,
      headers: auth(a.token),
      payload: { scope: 'USER', userId: a.userId, currency: 'IRR', costRateMinor: '60000', effectiveFrom: '2026-01-01' },
    });
    expect(rate.statusCode).toBe(201);

    // Log 60 minutes.
    const entry = await app.inject({
      method: 'POST',
      url: `/api/teams/${teamId}/time-entries`,
      headers: auth(a.token),
      payload: { projectId, date: '2026-06-01', minutes: 60 },
    });
    expect(entry.statusCode).toBe(201);
    expect(entry.json().costRateMinorSnapshot).toBe('60000');

    // Open the period (adopts the entry), submit, approve.
    const period = await app.inject({
      method: 'POST',
      url: `/api/teams/${teamId}/timesheets`,
      headers: auth(a.token),
      payload: { periodStart: '2026-06-01', periodEnd: '2026-06-07' },
    });
    expect(period.statusCode).toBe(201);
    const periodId = period.json().id as string;

    expect((await app.inject({ method: 'POST', url: `/api/teams/${teamId}/timesheets/${periodId}/submit`, headers: auth(a.token) })).json().status).toBe('SUBMITTED');
    const approved = await app.inject({ method: 'POST', url: `/api/teams/${teamId}/timesheets/${periodId}/approve`, headers: auth(a.token) });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().status).toBe('APPROVED');

    // Ledger has the labour entry.
    const actuals = await app.inject({ method: 'GET', url: `/api/teams/${teamId}/projects/${projectId}/cost/actuals`, headers: auth(a.token) });
    expect(actuals.json().items).toHaveLength(1);
    expect(actuals.json().items[0]).toMatchObject({ source: 'TIMESHEET', amountMinor: '60000' });

    // Summary: actual reflects it; add budget + commitment and check remaining.
    await app.inject({ method: 'POST', url: `/api/teams/${teamId}/projects/${projectId}/cost/budget-lines`, headers: auth(a.token), payload: { amountMinor: '100000', currency: 'IRR' } });
    await app.inject({ method: 'POST', url: `/api/teams/${teamId}/projects/${projectId}/cost/commitments`, headers: auth(a.token), payload: { amountMinor: '10000', currency: 'IRR' } });

    const summary = await app.inject({ method: 'GET', url: `/api/teams/${teamId}/projects/${projectId}/cost/summary`, headers: auth(a.token) });
    expect(summary.statusCode).toBe(200);
    const irr = summary.json().byCurrency.find((b: { currency: string }) => b.currency === 'IRR');
    expect(irr).toMatchObject({ plannedMinor: '100000', committedMinor: '10000', actualMinor: '60000', remainingMinor: '30000' });
    expect(summary.json().base).toMatchObject({ actualMinor: '60000', remainingMinor: '30000' });
  });

  it('reverses posted labour when an approved timesheet is reopened', async () => {
    const a = await register('a@example.com');
    const teamId = await createTeam(a.token, 'cost-c');
    const projectId = await createProject(a.token, teamId, 'Reopen');
    await enableModules(a.token, teamId, projectId);
    await app.inject({ method: 'POST', url: `/api/teams/${teamId}/rate-cards`, headers: auth(a.token), payload: { scope: 'USER', userId: a.userId, currency: 'IRR', costRateMinor: '30000', effectiveFrom: '2026-01-01' } });
    await app.inject({ method: 'POST', url: `/api/teams/${teamId}/time-entries`, headers: auth(a.token), payload: { projectId, date: '2026-06-02', minutes: 120 } });
    const periodId = (await app.inject({ method: 'POST', url: `/api/teams/${teamId}/timesheets`, headers: auth(a.token), payload: { periodStart: '2026-06-01', periodEnd: '2026-06-07' } })).json().id as string;
    await app.inject({ method: 'POST', url: `/api/teams/${teamId}/timesheets/${periodId}/submit`, headers: auth(a.token) });
    await app.inject({ method: 'POST', url: `/api/teams/${teamId}/timesheets/${periodId}/approve`, headers: auth(a.token) });
    const reopened = await app.inject({ method: 'POST', url: `/api/teams/${teamId}/timesheets/${periodId}/reopen`, headers: auth(a.token) });
    expect(reopened.json().status).toBe('REOPENED');

    // Original + reversal net to zero.
    const summary = await app.inject({ method: 'GET', url: `/api/teams/${teamId}/projects/${projectId}/cost/summary`, headers: auth(a.token) });
    expect(summary.json().base.actualMinor).toBe('0');
  });

  it('blocks a team MEMBER without timesheet.manage_rates from the rate-card admin (403)', async () => {
    const mgr = await register('mgr@example.com', 'Mgr');
    const teamId = await createTeam(mgr.token, 'cost-d');
    const member = await register('mem@example.com', 'Mem');
    await app.inject({ method: 'POST', url: `/api/teams/${teamId}/members`, headers: auth(mgr.token), payload: { email: 'mem@example.com', role: 'MEMBER' } });

    const res = await app.inject({ method: 'GET', url: `/api/teams/${teamId}/rate-cards`, headers: auth(member.token) });
    expect(res.statusCode).toBe(403);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';

let app: FastifyInstance;

beforeAll(async () => {
  const env = loadEnv();
  app = await buildApp(env);
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await prisma.refreshToken.deleteMany();
  await prisma.task.deleteMany();
  await prisma.project.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
});

const PASSWORD = 'CorrectHorseBattery9';

async function inject(opts: Parameters<FastifyInstance['inject']>[0]) {
  return app.inject(opts);
}

async function setupTeam(name = 'BudgetTeam', slug = 'budget-team') {
  const reg = await bootstrapUser(app, { email: 'owner@example.com', name: 'Owner', password: PASSWORD });
  const team = (
    await inject({
      method: 'POST',
      url: '/api/teams',
      headers: { authorization: `Bearer ${reg.token}` },
      payload: { name, slug },
    })
  ).json();
  return { token: reg.token, teamId: team.id as string, userId: reg.userId };
}

async function createProject(
  token: string,
  teamId: string,
  payload: Record<string, unknown>,
) {
  return (
    await inject({
      method: 'POST',
      url: `/api/teams/${teamId}/projects`,
      headers: { authorization: `Bearer ${token}` },
      payload,
    })
  ).json();
}

describe('GET /api/teams/:teamId/reports/budget', () => {
  it('returns per-project planned/actual/variance and per-currency rollup', async () => {
    const { token, teamId } = await setupTeam();
    const irr = await createProject(token, teamId, {
      name: 'IRR Project',
      plannedBudget: '1000.00',
      actualSpent: '800.00',
      budgetCurrency: 'IRR',
    });
    const usd = await createProject(token, teamId, {
      name: 'USD Project',
      plannedBudget: '500.00',
      actualSpent: '600.00',
      budgetCurrency: 'USD',
    });
    await createProject(token, teamId, { name: 'No budget' });

    const res = await inject({
      method: 'GET',
      url: `/api/teams/${teamId}/reports/budget`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      projects: Array<{
        projectId: string;
        projectName: string;
        hasBudget: boolean;
        variance: string | null;
        utilizationPct: string | null;
        overBudget: boolean;
      }>;
      rollupByCurrency: Array<{ currency: string; totalPlanned: string | null; overBudgetCount: number }>;
    };

    const irrRow = body.projects.find((p) => p.projectId === irr.id)!;
    expect(irrRow.variance).toBe('200.00');
    expect(irrRow.utilizationPct).toBe('80.00');
    expect(irrRow.overBudget).toBe(false);

    const usdRow = body.projects.find((p) => p.projectId === usd.id)!;
    expect(usdRow.overBudget).toBe(true);
    expect(usdRow.utilizationPct).toBe('120.00');

    const emptyRow = body.projects.find((p) => p.projectName === 'No budget')!;
    expect(emptyRow.hasBudget).toBe(false);
    expect(emptyRow.utilizationPct).toBeNull();

    expect(body.rollupByCurrency).toHaveLength(2);
    const irrRollup = body.rollupByCurrency.find((r) => r.currency === 'IRR')!;
    const usdRollup = body.rollupByCurrency.find((r) => r.currency === 'USD')!;
    expect(irrRollup.totalPlanned).toBe('1000.00');
    expect(usdRollup.totalPlanned).toBe('500.00');
    expect(usdRollup.overBudgetCount).toBe(1);
  });

  it('returns null utilization when plannedBudget is zero', async () => {
    const { token, teamId } = await setupTeam('ZeroTeam', 'zero-team');
    await createProject(token, teamId, {
      name: 'Zero planned',
      plannedBudget: '0',
      actualSpent: '10.00',
    });

    const res = await inject({
      method: 'GET',
      url: `/api/teams/${teamId}/reports/budget`,
      headers: { authorization: `Bearer ${token}` },
    });
    const body = res.json() as { projects: Array<{ utilizationPct: string | null; overBudget: boolean }> };
    expect(body.projects[0].utilizationPct).toBeNull();
    expect(body.projects[0].overBudget).toBe(true);
  });

  it('scopes results to the requested team only', async () => {
    const teamA = await setupTeam('TeamA', 'team-a-budget');
    const regB = await bootstrapUser(app, {
      email: 'other@example.com',
      name: 'Other',
      password: PASSWORD,
    });
    const teamB = (
      await inject({
        method: 'POST',
        url: '/api/teams',
        headers: { authorization: `Bearer ${regB.token}` },
        payload: { name: 'TeamB', slug: 'team-b-budget' },
      })
    ).json();
    await createProject(teamA.token, teamA.teamId, {
      name: 'A only',
      plannedBudget: '100.00',
      actualSpent: '50.00',
    });
    await createProject(regB.token, teamB.id as string, {
      name: 'B only',
      plannedBudget: '999.00',
      actualSpent: '1.00',
    });

    const res = await inject({
      method: 'GET',
      url: `/api/teams/${teamA.teamId}/reports/budget`,
      headers: { authorization: `Bearer ${teamA.token}` },
    });
    const body = res.json() as { projects: Array<{ projectName: string }> };
    expect(body.projects.map((p) => p.projectName)).toEqual(['A only']);
  });
});

describe('GET /api/teams/:teamId/reports/budget.csv', () => {
  it('exports flat rows with currency column', async () => {
    const { token, teamId } = await setupTeam('CsvBudget', 'csv-budget');
    await createProject(token, teamId, {
      name: 'Export me',
      plannedBudget: '100.00',
      actualSpent: '75.00',
      budgetCurrency: 'EUR',
    });

    const res = await inject({
      method: 'GET',
      url: `/api/teams/${teamId}/reports/budget.csv`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(String(res.headers['content-disposition'])).toMatch(
      /^attachment; filename="budget-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    const body = res.body;
    expect(body).toMatch(
      /project_id,project_name,currency,has_budget,planned_budget,actual_spent,variance,variance_pct,utilization_pct,over_budget/,
    );
    expect(body).toMatch(/Export me/);
    expect(body).toMatch(/EUR/);
    expect(body).toMatch(/75\.00/);
  });
});

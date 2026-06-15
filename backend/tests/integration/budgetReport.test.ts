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
  it('returns per-project planned budgets and per-currency rollup', async () => {
    const { token, teamId } = await setupTeam();
    const irr = await createProject(token, teamId, {
      name: 'IRR Project',
      plannedBudget: '1000.00',
      budgetCurrency: 'IRR',
    });
    const usd = await createProject(token, teamId, {
      name: 'USD Project',
      plannedBudget: '500.00',
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
        plannedBudget: string | null;
      }>;
      rollupByCurrency: Array<{ currency: string; totalPlanned: string | null; projectsWithBudget: number }>;
    };

    const irrRow = body.projects.find((p) => p.projectId === irr.id)!;
    expect(irrRow.hasBudget).toBe(true);
    expect(irrRow.plannedBudget).toBe('1000.00');

    const usdRow = body.projects.find((p) => p.projectId === usd.id)!;
    expect(usdRow.hasBudget).toBe(true);
    expect(usdRow.plannedBudget).toBe('500.00');

    const emptyRow = body.projects.find((p) => p.projectName === 'No budget')!;
    expect(emptyRow.hasBudget).toBe(false);
    expect(emptyRow.plannedBudget).toBeNull();

    expect(body.rollupByCurrency).toHaveLength(2);
    const irrRollup = body.rollupByCurrency.find((r) => r.currency === 'IRR')!;
    const usdRollup = body.rollupByCurrency.find((r) => r.currency === 'USD')!;
    expect(irrRollup.totalPlanned).toBe('1000.00');
    expect(usdRollup.totalPlanned).toBe('500.00');
    expect(usdRollup.projectsWithBudget).toBe(1);
  });

  it('treats zero plannedBudget as a budget row', async () => {
    const { token, teamId } = await setupTeam('ZeroTeam', 'zero-team');
    await createProject(token, teamId, {
      name: 'Zero planned',
      plannedBudget: '0',
    });

    const res = await inject({
      method: 'GET',
      url: `/api/teams/${teamId}/reports/budget`,
      headers: { authorization: `Bearer ${token}` },
    });
    const body = res.json() as { projects: Array<{ hasBudget: boolean; plannedBudget: string | null }> };
    expect(body.projects[0].hasBudget).toBe(true);
    expect(body.projects[0].plannedBudget).toBe('0.00');
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
    });
    await createProject(regB.token, teamB.id as string, {
      name: 'B only',
      plannedBudget: '999.00',
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
    expect(body).toMatch(/project_id,project_name,currency,has_budget,planned_budget/);
    expect(body).not.toMatch(/actual_spent/);
    expect(body).toMatch(/Export me/);
    expect(body).toMatch(/EUR/);
    expect(body).toMatch(/100\.00/);
  });
});

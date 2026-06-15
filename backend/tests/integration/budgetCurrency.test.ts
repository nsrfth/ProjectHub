import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { GlobalRole } from '@prisma/client';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { formatBudget } from '../../src/lib/formatBudget.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';

let app: FastifyInstance;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_ACCESS_SECRET ||= 'test_access_secret_at_least_32_chars_long_xx';
  process.env.JWT_REFRESH_SECRET ||= 'test_refresh_secret_at_least_32_chars_long_x';
  process.env.CORS_ORIGINS ||= 'http://localhost:5173';
  process.env.COOKIE_SECURE ||= 'false';

  app = await buildApp(loadEnv());
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await prisma.refreshToken.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.customFieldValueOption.deleteMany();
  await prisma.customFieldValue.deleteMany();
  await prisma.customFieldOption.deleteMany();
  await prisma.customFieldDefinition.deleteMany();
  await prisma.projectGroupGrant.deleteMany();
  await prisma.userGroupMember.deleteMany();
  await prisma.userGroup.deleteMany();
  await prisma.activity.deleteMany();
  await prisma.comment.deleteMany();
  await prisma.task.deleteMany();
  await prisma.project.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.rolePermission.deleteMany();
  await prisma.role.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
});

async function inject(opts: Parameters<FastifyInstance['inject']>[0]) {
  return app.inject(opts);
}

const PASSWORD = 'CorrectHorseBattery9';

async function registerUser(email: string, globalRole?: GlobalRole) {
  return bootstrapUser(app, {
    email,
    name: email,
    password: PASSWORD,
    globalRole: globalRole ?? GlobalRole.MEMBER,
  });
}

async function createTeam(token: string, slug: string) {
  const res = await inject({
    method: 'POST',
    url: '/api/teams',
    headers: { authorization: `Bearer ${token}` },
    payload: { name: slug, slug },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; defaultCurrency: string };
}

async function addMember(
  mgrToken: string,
  teamId: string,
  email: string,
  role: 'MEMBER' | 'MANAGER',
) {
  const res = await inject({
    method: 'POST',
    url: `/api/teams/${teamId}/members`,
    headers: { authorization: `Bearer ${mgrToken}` },
    payload: { email, role },
  });
  expect(res.statusCode).toBe(201);
}

describe('v1.59 Budget currency', () => {
  it('1) new project defaults to team default currency; overridable', async () => {
    const mgr = await registerUser('bc-mgr-1@test.local');
    const team = await createTeam(mgr.token, 'bc-team-1');

    await inject({
      method: 'PATCH',
      url: `/api/teams/${team.id}`,
      headers: { authorization: `Bearer ${mgr.token}` },
      payload: { defaultCurrency: 'EUR' },
    });

    const defaultRes = await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects`,
      headers: { authorization: `Bearer ${mgr.token}` },
      payload: { name: 'Default EUR project' },
    });
    expect(defaultRes.statusCode).toBe(201);
    expect(defaultRes.json().budgetCurrency).toBe('EUR');

    const overrideRes = await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects`,
      headers: { authorization: `Bearer ${mgr.token}` },
      payload: { name: 'USD project', budgetCurrency: 'USD' },
    });
    expect(overrideRes.statusCode).toBe(201);
    expect(overrideRes.json().budgetCurrency).toBe('USD');
  });

  it('2) project budget displays formatted with its currency', () => {
    const formatted = formatBudget('12000', 'EUR', 'en-US');
    expect(formatted).toContain('12,000.00');
  });

  it('3) task budget uses parent project currency', async () => {
    const mgr = await registerUser('bc-mgr-3@test.local');
    const team = await createTeam(mgr.token, 'bc-team-3');

    const projectRes = await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects`,
      headers: { authorization: `Bearer ${mgr.token}` },
      payload: { name: 'EUR project', budgetCurrency: 'EUR', plannedBudget: '5000' },
    });
    const project = projectRes.json() as { id: string };

    const taskRes = await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks`,
      headers: { authorization: `Bearer ${mgr.token}` },
      payload: { title: 'Task with budget', plannedBudget: '1000' },
    });
    expect(taskRes.statusCode).toBe(201);
    expect(taskRes.json().budgetCurrency).toBe('EUR');
  });

  it('4) team default pre-fills new projects only', async () => {
    const mgr = await registerUser('bc-mgr-4@test.local');
    const team = await createTeam(mgr.token, 'bc-team-4');

    const existingRes = await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects`,
      headers: { authorization: `Bearer ${mgr.token}` },
      payload: { name: 'Existing IRR', budgetCurrency: 'IRR' },
    });
    const existing = existingRes.json() as { id: string };

    await inject({
      method: 'PATCH',
      url: `/api/teams/${team.id}`,
      headers: { authorization: `Bearer ${mgr.token}` },
      payload: { defaultCurrency: 'USD' },
    });

    const newRes = await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects`,
      headers: { authorization: `Bearer ${mgr.token}` },
      payload: { name: 'New USD default' },
    });
    expect(newRes.json().budgetCurrency).toBe('USD');

    const getExisting = await inject({
      method: 'GET',
      url: `/api/teams/${team.id}/projects/${existing.id}`,
      headers: { authorization: `Bearer ${mgr.token}` },
    });
    expect(getExisting.json().budgetCurrency).toBe('IRR');
  });

  it('5) changing project currency relabels without altering stored amount', async () => {
    const mgr = await registerUser('bc-mgr-5@test.local');
    const team = await createTeam(mgr.token, 'bc-team-5');

    const createRes = await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects`,
      headers: { authorization: `Bearer ${mgr.token}` },
      payload: { name: 'Budget project', plannedBudget: '12000.50', budgetCurrency: 'EUR' },
    });
    const project = createRes.json() as { id: string; plannedBudget: string };

    const patchRes = await inject({
      method: 'PATCH',
      url: `/api/teams/${team.id}/projects/${project.id}`,
      headers: { authorization: `Bearer ${mgr.token}` },
      payload: { budgetCurrency: 'USD' },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().budgetCurrency).toBe('USD');
    expect(patchRes.json().plannedBudget).toBe('12000.50');
  });

  it('6) invalid currency value returns 400', async () => {
    const mgr = await registerUser('bc-mgr-6@test.local');
    const team = await createTeam(mgr.token, 'bc-team-6');

    const res = await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects`,
      headers: { authorization: `Bearer ${mgr.token}` },
      payload: { name: 'Bad currency', budgetCurrency: 'GBP' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('7) FA locale formats with Persian digits; EN with Latin', () => {
    const en = formatBudget('12000', 'EUR', 'en-US');
    const fa = formatBudget('12000', 'EUR', 'fa-IR');
    expect(en).toMatch(/[0-9]/);
    expect(fa).toMatch(/[\u06F0-\u06F9]/);
    expect(en).not.toMatch(/[\u06F0-\u06F9]/);
  });

  it('8) pre-migration-style projects load with backfilled IRR and budgets intact', async () => {
    const mgr = await registerUser('bc-mgr-8@test.local');
    const team = await createTeam(mgr.token, 'bc-team-8');

    const row = await prisma.project.create({
      data: {
        teamId: team.id,
        ownerId: mgr.userId,
        name: 'Legacy project',
        plannedBudget: '9999.99',
        budgetCurrency: 'IRR',
      },
    });

    const res = await inject({
      method: 'GET',
      url: `/api/teams/${team.id}/projects/${row.id}`,
      headers: { authorization: `Bearer ${mgr.token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.budgetCurrency).toBe('IRR');
    expect(body.plannedBudget).toBe('9999.99');
  });

  it('9) IRR 12000.00 displays with 0 decimals; stored Decimal unchanged', async () => {
    const display = formatBudget('12000.00', 'IRR', 'en-US');
    expect(display).not.toContain('.00');

    const mgr = await registerUser('bc-mgr-9@test.local');
    const team = await createTeam(mgr.token, 'bc-team-9');
    const createRes = await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects`,
      headers: { authorization: `Bearer ${mgr.token}` },
      payload: { name: 'IRR project', plannedBudget: '12000', budgetCurrency: 'IRR' },
    });
    expect(createRes.json().plannedBudget).toBe('12000.00');
    expect(formatBudget(createRes.json().plannedBudget, 'IRR', 'en-US')).toContain('12,000');
  });

  it('10) member without team.edit_details cannot change team default currency', async () => {
    const mgr = await registerUser('bc-mgr-10@test.local');
    const member = await registerUser('bc-mem-10@test.local');
    const team = await createTeam(mgr.token, 'bc-team-10');
    await addMember(mgr.token, team.id, 'bc-mem-10@test.local', 'MEMBER');

    const res = await inject({
      method: 'PATCH',
      url: `/api/teams/${team.id}`,
      headers: { authorization: `Bearer ${member.token}` },
      payload: { defaultCurrency: 'USD' },
    });
    expect(res.statusCode).toBe(403);
  });
});

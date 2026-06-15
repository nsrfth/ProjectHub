import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
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
  await prisma.project.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
});

async function inject(opts: Parameters<FastifyInstance['inject']>[0]) {
  return app.inject(opts);
}

const PASSWORD = 'CorrectHorseBattery9';

async function registerMember(email: string) {
  return bootstrapUser(app, { email, name: email, password: PASSWORD, globalRole: 'MEMBER' });
}

async function createTeam(token: string, slug: string) {
  const res = await inject({
    method: 'POST',
    url: '/api/teams',
    headers: { authorization: `Bearer ${token}` },
    payload: { name: slug, slug },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string };
}

async function createProject(token: string, teamId: string, name: string) {
  const res = await inject({
    method: 'POST',
    url: `/api/teams/${teamId}/projects`,
    headers: { authorization: `Bearer ${token}` },
    payload: { name, description: 'Initial desc' },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; name: string; description: string | null; status: string };
}

describe('Project actions menu — API regression', () => {
  it('2) edit project saves name + description + status', async () => {
    const owner = await registerMember('pam-owner@test.local');
    const team = await createTeam(owner.token, 'pam-2');
    const project = await createProject(owner.token, team.id, 'Before');

    const patch = await inject({
      method: 'PATCH',
      url: `/api/teams/${team.id}/projects/${project.id}`,
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { name: 'After', description: 'Updated desc', status: 'ON_HOLD' },
    });
    expect(patch.statusCode).toBe(200);
    const body = patch.json();
    expect(body.name).toBe('After');
    expect(body.description).toBe('Updated desc');
    expect(body.status).toBe('ON_HOLD');

    const list = await inject({
      method: 'GET',
      url: '/api/projects',
      headers: { authorization: `Bearer ${owner.token}` },
    });
    const row = list.json().find((p: { id: string }) => p.id === project.id);
    expect(row.name).toBe('After');
    expect(row.description).toBe('Updated desc');
    expect(row.status).toBe('ON_HOLD');
  });

  it('3) edit budget persists planned/actual/currency', async () => {
    const owner = await registerMember('pam-budget@test.local');
    const team = await createTeam(owner.token, 'pam-3');
    const project = await createProject(owner.token, team.id, 'Budgeted');

    const patch = await inject({
      method: 'PATCH',
      url: `/api/teams/${team.id}/projects/${project.id}`,
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { plannedBudget: '1000.00', budgetCurrency: 'EUR' },
    });
    expect(patch.statusCode).toBe(200);
    const body = patch.json();
    expect(body.plannedBudget).toBe('1000.00');
    expect(body.budgetCurrency).toBe('EUR');
  });

  it('4) delete removes project from list', async () => {
    const owner = await registerMember('pam-del@test.local');
    const team = await createTeam(owner.token, 'pam-4');
    const project = await createProject(owner.token, team.id, 'Gone');

    const del = await inject({
      method: 'DELETE',
      url: `/api/teams/${team.id}/projects/${project.id}`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(del.statusCode).toBe(204);

    const list = await inject({
      method: 'GET',
      url: '/api/projects',
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(list.json().some((p: { id: string }) => p.id === project.id)).toBe(false);
  });

  it('5) member without manage rights cannot PATCH another owners project', async () => {
    const owner = await registerMember('pam-o5@test.local');
    const member = await registerMember('pam-m5@test.local');
    const team = await createTeam(owner.token, 'pam-5');
    await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/members`,
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { email: 'pam-m5@test.local', role: 'MEMBER' },
    });
    const project = await createProject(owner.token, team.id, 'Private');

    const patch = await inject({
      method: 'PATCH',
      url: `/api/teams/${team.id}/projects/${project.id}`,
      headers: { authorization: `Bearer ${member.token}` },
      payload: { name: 'Hacked' },
    });
    expect(patch.statusCode).toBe(404);
  });

  it('6) manager renaming others project gets 403 when changing status/description', async () => {
    const owner = await registerMember('pam-o6@test.local');
    const mgr = await registerMember('pam-m6@test.local');
    const team = await createTeam(owner.token, 'pam-6');
    await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/members`,
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { email: 'pam-m6@test.local', role: 'MANAGER' },
    });
    const project = await createProject(owner.token, team.id, 'MgrTarget');

    const rename = await inject({
      method: 'PATCH',
      url: `/api/teams/${team.id}/projects/${project.id}`,
      headers: { authorization: `Bearer ${mgr.token}` },
      payload: { name: 'Renamed only' },
    });
    expect(rename.statusCode).toBe(200);

    const status = await inject({
      method: 'PATCH',
      url: `/api/teams/${team.id}/projects/${project.id}`,
      headers: { authorization: `Bearer ${mgr.token}` },
      payload: { status: 'ARCHIVED' },
    });
    expect(status.statusCode).toBe(403);

    const desc = await inject({
      method: 'PATCH',
      url: `/api/teams/${team.id}/projects/${project.id}`,
      headers: { authorization: `Bearer ${mgr.token}` },
      payload: { description: 'Nope' },
    });
    expect(desc.statusCode).toBe(403);

    const get = await inject({
      method: 'GET',
      url: `/api/teams/${team.id}/projects/${project.id}`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(get.json().name).toBe('Renamed only');
    expect(get.json().status).not.toBe('ARCHIVED');
  });
});

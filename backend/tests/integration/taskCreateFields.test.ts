import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { GlobalRole } from '@prisma/client';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';

// v1.78: task create with optional startDate, dueDate, responsibleId.
// Eligible responsible = team members ∪ accepted group-granted members.

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
  await prisma.projectGroupGrant.deleteMany();
  await prisma.userGroupMember.deleteMany();
  await prisma.userGroup.deleteMany();
  await prisma.task.deleteMany();
  await prisma.project.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
});

async function inject(opts: Parameters<FastifyInstance['inject']>[0]) {
  return app.inject(opts);
}

const PASSWORD = 'CorrectHorseBattery9';

async function registerUser(email: string) {
  return bootstrapUser(app, { email, name: email, password: PASSWORD });
}

async function registerMember(email: string) {
  return bootstrapUser(app, {
    email,
    name: email,
    password: PASSWORD,
    globalRole: GlobalRole.MEMBER,
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
  return res.json() as { id: string };
}

async function addMember(
  mgrToken: string,
  teamId: string,
  email: string,
  role: 'MEMBER' | 'MANAGER' = 'MEMBER',
) {
  const res = await inject({
    method: 'POST',
    url: `/api/teams/${teamId}/members`,
    headers: { authorization: `Bearer ${mgrToken}` },
    payload: { email, role },
  });
  expect(res.statusCode).toBe(201);
}

async function createProject(token: string, teamId: string, name: string) {
  const res = await inject({
    method: 'POST',
    url: `/api/teams/${teamId}/projects`,
    headers: { authorization: `Bearer ${token}` },
    payload: { name },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string };
}

async function createGroup(mgrToken: string, teamId: string, name: string) {
  const res = await inject({
    method: 'POST',
    url: `/api/teams/${teamId}/groups`,
    headers: { authorization: `Bearer ${mgrToken}` },
    payload: { name },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string };
}

async function addGroupMember(
  mgrToken: string,
  teamId: string,
  groupId: string,
  userId: string,
) {
  const res = await inject({
    method: 'POST',
    url: `/api/teams/${teamId}/groups/${groupId}/members`,
    headers: { authorization: `Bearer ${mgrToken}` },
    payload: { userId, accessLevel: 'FULL' },
  });
  expect(res.statusCode).toBe(200);
}

async function grantProjects(
  mgrToken: string,
  teamId: string,
  groupId: string,
  projectIds: string[],
) {
  const res = await inject({
    method: 'PUT',
    url: `/api/teams/${teamId}/groups/${groupId}/projects`,
    headers: { authorization: `Bearer ${mgrToken}` },
    payload: { projectIds },
  });
  expect(res.statusCode).toBe(200);
}

const START = '2026-06-01T00:00:00.000Z';
const DUE = '2026-06-10T00:00:00.000Z';
const DUE_BEFORE = '2026-05-28T00:00:00.000Z';

describe('task create — start/due dates + responsible (v1.78)', () => {
  it('creates with start+due+responsible and persists UTC-midnight dates', async () => {
    const admin = await registerUser('tc78-admin@example.com');
    const owner = await registerMember('tc78-owner@example.com');
    const other = await registerMember('tc78-other@example.com');
    const team = await createTeam(admin.token, 'tc78-team');
    await addMember(admin.token, team.id, owner.email);
    await addMember(admin.token, team.id, other.email);
    const proj = await createProject(owner.token, team.id, 'P');

    const res = await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects/${proj.id}/tasks`,
      headers: { authorization: `Bearer ${owner.token}` },
      payload: {
        title: 'Scheduled',
        startDate: START,
        dueDate: DUE,
        responsibleId: other.userId,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      startDate: string;
      dueDate: string;
      responsibleId: string;
    };
    expect(body.startDate).toBe(START);
    expect(body.dueDate).toBe(DUE);
    expect(body.responsibleId).toBe(other.userId);
  });

  it('rejects dueDate before startDate with 400', async () => {
    const admin = await registerUser('tc78b-admin@example.com');
    const owner = await registerMember('tc78b-owner@example.com');
    const team = await createTeam(admin.token, 'tc78b-team');
    await addMember(admin.token, team.id, owner.email);
    const proj = await createProject(owner.token, team.id, 'P');

    const res = await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects/${proj.id}/tasks`,
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { title: 'Bad range', startDate: START, dueDate: DUE_BEFORE },
    });
    expect(res.statusCode).toBe(400);
  });

  it('title-only create still works', async () => {
    const admin = await registerUser('tc78c-admin@example.com');
    const owner = await registerMember('tc78c-owner@example.com');
    const team = await createTeam(admin.token, 'tc78c-team');
    await addMember(admin.token, team.id, owner.email);
    const proj = await createProject(owner.token, team.id, 'P');

    const res = await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects/${proj.id}/tasks`,
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { title: 'Quick' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      startDate: string | null;
      dueDate: string | null;
      responsibleId: string;
    };
    expect(body.startDate).toBeNull();
    expect(body.dueDate).toBeNull();
    expect(body.responsibleId).toBe(owner.userId);
  });

  it('responsible-candidates lists team + accepted group-granted members', async () => {
    const admin = await registerUser('tc78d-admin@example.com');
    const owner = await registerMember('tc78d-owner@example.com');
    const grantee = await registerMember('tc78d-grantee@example.com');
    const team = await createTeam(admin.token, 'tc78d-team');
    await addMember(admin.token, team.id, owner.email);
    await addMember(admin.token, team.id, grantee.email);
    const proj = await createProject(owner.token, team.id, 'Shared');
    const group = await createGroup(admin.token, team.id, 'G');
    await addGroupMember(admin.token, team.id, group.id, grantee.userId);
    await grantProjects(admin.token, team.id, group.id, [proj.id]);

    const res = await inject({
      method: 'GET',
      url: `/api/teams/${team.id}/projects/${proj.id}/tasks/responsible-candidates`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as { items: Array<{ userId: string }> }).items.map((i) => i.userId);
    expect(ids).toContain(owner.userId);
    expect(ids).toContain(grantee.userId);
  });

  it('rejects non-eligible responsibleId with 400', async () => {
    const admin = await registerUser('tc78e-admin@example.com');
    const owner = await registerMember('tc78e-owner@example.com');
    const outsider = await registerMember('tc78e-outsider@example.com');
    const team = await createTeam(admin.token, 'tc78e-team');
    await addMember(admin.token, team.id, owner.email);
    const proj = await createProject(owner.token, team.id, 'Private');

    const res = await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects/${proj.id}/tasks`,
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { title: 'Bad responsible', responsibleId: outsider.userId },
    });
    expect(res.statusCode).toBe(400);
  });

  it('does not leak responsible-candidates to users without project access', async () => {
    const admin = await registerUser('tc78f-admin@example.com');
    const owner = await registerMember('tc78f-owner@example.com');
    const outsider = await registerMember('tc78f-outsider@example.com');
    const team = await createTeam(admin.token, 'tc78f-team');
    await addMember(admin.token, team.id, owner.email);
    await addMember(admin.token, team.id, outsider.email);
    const proj = await createProject(owner.token, team.id, 'Private');

    const res = await inject({
      method: 'GET',
      url: `/api/teams/${team.id}/projects/${proj.id}/tasks/responsible-candidates`,
      headers: { authorization: `Bearer ${outsider.token}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

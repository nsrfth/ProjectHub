import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';

// W1.1: the project-scoped resource-assignment routes are now gated behind the
// `resource_mgmt` profile module (they were reachable with the module disabled).
// Covers: disabled → 403 module_disabled; enabled → happy path; cross-team →
// 403 (auth gate fires before the module gate).

let app: FastifyInstance;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_ACCESS_SECRET ||= 'test_access_secret_at_least_32_chars_long_xx';
  process.env.JWT_REFRESH_SECRET ||= 'test_refresh_secret_at_least_32_chars_long_x';
  process.env.CORS_ORIGINS ||= 'http://localhost:5173';
  process.env.COOKIE_SECURE ||= 'false';
  process.env.MASTER_KEY ??=
    '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
  app = await buildApp(loadEnv());
});

afterAll(async () => {
  if (app) await app.close();
});

beforeEach(async () => {
  await prisma.resourceAssignment.deleteMany();
  await prisma.resource.deleteMany();
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

async function register(email: string, name = 'User', globalRole?: 'ADMIN' | 'MEMBER') {
  return bootstrapUser(app, { email, name, password: PASSWORD, globalRole });
}

async function createTeam(token: string, slug: string): Promise<string> {
  const r = await app.inject({
    method: 'POST',
    url: '/api/teams',
    headers: { authorization: `Bearer ${token}` },
    payload: { name: slug, slug },
  });
  if (r.statusCode !== 201) throw new Error(`createTeam: ${r.statusCode} ${r.body}`);
  return r.json().id as string;
}

async function createProject(token: string, teamId: string, name: string): Promise<string> {
  const r = await app.inject({
    method: 'POST',
    url: `/api/teams/${teamId}/projects`,
    headers: { authorization: `Bearer ${token}` },
    payload: { name },
  });
  if (r.statusCode !== 201) throw new Error(`createProject: ${r.statusCode} ${r.body}`);
  return r.json().id as string;
}

function assignmentsUrl(teamId: string, projectId: string, taskId: string): string {
  return `/api/teams/${teamId}/projects/${projectId}/tasks/${taskId}/assignments`;
}

async function enableResourceMgmt(token: string, teamId: string, projectId: string): Promise<void> {
  const r = await app.inject({
    method: 'PUT',
    url: `/api/teams/${teamId}/projects/${projectId}/profile/overrides`,
    headers: { authorization: `Bearer ${token}` },
    payload: { overrides: { resource_mgmt: { enabled: true } } },
  });
  if (r.statusCode !== 200) throw new Error(`enableResourceMgmt: ${r.statusCode} ${r.body}`);
}

describe('resource_mgmt module gating (W1.1)', () => {
  it('blocks task-assignment routes with the module disabled (403 module_disabled)', async () => {
    const a = await register('a@example.com', 'Alice');
    const teamId = await createTeam(a.token, 'rm-a');
    const projectId = await createProject(a.token, teamId, 'P');
    const task = await prisma.task.create({ data: { teamId, projectId, title: 'T1', status: 'TODO' } });
    const resource = await prisma.resource.create({ data: { teamId, name: 'R1', type: 'HUMAN', maxUnits: 1 } });

    const post = await app.inject({
      method: 'POST',
      url: assignmentsUrl(teamId, projectId, task.id),
      headers: { authorization: `Bearer ${a.token}` },
      payload: { resourceId: resource.id, units: 1 },
    });
    expect(post.statusCode).toBe(403);
    expect(post.json().error.code).toBe('module_disabled');

    const get = await app.inject({
      method: 'GET',
      url: assignmentsUrl(teamId, projectId, task.id),
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(get.statusCode).toBe(403);
    expect(get.json().error.code).toBe('module_disabled');
  });

  it('allows assignments once resource_mgmt is enabled', async () => {
    const a = await register('a@example.com', 'Alice');
    const teamId = await createTeam(a.token, 'rm-a');
    const projectId = await createProject(a.token, teamId, 'P');
    const task = await prisma.task.create({ data: { teamId, projectId, title: 'T1', status: 'TODO' } });
    const resource = await prisma.resource.create({ data: { teamId, name: 'R1', type: 'HUMAN', maxUnits: 1 } });

    await enableResourceMgmt(a.token, teamId, projectId);

    const post = await app.inject({
      method: 'POST',
      url: assignmentsUrl(teamId, projectId, task.id),
      headers: { authorization: `Bearer ${a.token}` },
      payload: { resourceId: resource.id, units: 1, plannedHours: 8 },
    });
    expect(post.statusCode).toBe(201);

    const get = await app.inject({
      method: 'GET',
      url: assignmentsUrl(teamId, projectId, task.id),
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(get.statusCode).toBe(200);
    expect((get.json() as { items: unknown[] }).items).toHaveLength(1);
  });

  it('cross-team caller is blocked by the auth gate before the module gate (opaque 404/403)', async () => {
    const a = await register('a@example.com', 'Alice');
    const b = await register('b@example.com', 'Bob', 'MEMBER');
    const teamA = await createTeam(a.token, 'rm-a');
    const projectA = await createProject(a.token, teamA, 'PA');
    const task = await prisma.task.create({ data: { teamId: teamA, projectId: projectA, title: 'T', status: 'TODO' } });

    const res = await app.inject({
      method: 'GET',
      url: assignmentsUrl(teamA, projectA, task.id),
      headers: { authorization: `Bearer ${b.token}` },
    });
    // Auth/project-access gate fires before the module gate and returns an
    // opaque 404 (not module_disabled) so the module's existence never leaks.
    expect([403, 404]).toContain(res.statusCode);
    expect(res.json().error.code).not.toBe('module_disabled');
  });
});

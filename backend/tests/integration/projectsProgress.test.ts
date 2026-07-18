import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';

// v2.5.59: `progressPct` on GET /api/projects — mean percentComplete over LIVE
// LEAF tasks, feeding the year timeline's green fill. Same earned-value
// definition evmService uses. Soft-deleted rows and summary rows are excluded
// (a summary's percentComplete is a rollup of its leaves and would double
// count). Projects with no live leaf tasks report 0.

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
  await prisma.comment.deleteMany();
  await prisma.activity.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.projectTeamShare.deleteMany();
  await prisma.task.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.project.deleteMany();
  await prisma.rolePermission.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.role.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
  await prisma.instanceSetting.deleteMany();
});

const PASSWORD = 'CorrectHorseBattery9';

async function register(email: string, globalRole: 'ADMIN' | 'MEMBER' = 'ADMIN') {
  const r = await bootstrapUser(app, {
    email,
    name: email.split('@')[0],
    password: PASSWORD,
    globalRole,
  });
  return { token: r.token, userId: r.userId };
}

async function createTeam(token: string, slug: string): Promise<string> {
  const r = await app.inject({
    method: 'POST',
    url: '/api/teams',
    headers: { authorization: `Bearer ${token}` },
    payload: { name: slug, slug },
  });
  if (r.statusCode !== 201) throw new Error(`createTeam failed: ${r.statusCode} ${r.body}`);
  return r.json().id as string;
}

async function createProject(token: string, teamId: string, name: string): Promise<string> {
  const r = await app.inject({
    method: 'POST',
    url: `/api/teams/${teamId}/projects`,
    headers: { authorization: `Bearer ${token}` },
    payload: { name },
  });
  if (r.statusCode !== 201) throw new Error(`createProject failed: ${r.statusCode} ${r.body}`);
  return r.json().id as string;
}

async function createTask(
  token: string,
  teamId: string,
  projectId: string,
  title: string,
  percentComplete: number,
): Promise<string> {
  const r = await app.inject({
    method: 'POST',
    url: `/api/teams/${teamId}/projects/${projectId}/tasks`,
    headers: { authorization: `Bearer ${token}` },
    payload: { title, percentComplete },
  });
  if (r.statusCode !== 201) throw new Error(`createTask failed: ${r.statusCode} ${r.body}`);
  return r.json().id as string;
}

async function listAll(token: string) {
  const r = await app.inject({
    method: 'GET',
    url: '/api/projects',
    headers: { authorization: `Bearer ${token}` },
  });
  expect(r.statusCode).toBe(200);
  return r.json() as Array<{ id: string; name: string; progressPct: number }>;
}

describe('GET /api/projects — progressPct', () => {
  it('averages percentComplete across live leaf tasks', async () => {
    const admin = await register('admin@example.com');
    const teamId = await createTeam(admin.token, 'team-a');
    const projectId = await createProject(admin.token, teamId, 'P1');

    for (const [i, pct] of [100, 50, 50, 0].entries()) {
      await createTask(admin.token, teamId, projectId, `T${i}`, pct);
    }

    const rows = await listAll(admin.token);
    expect(rows.find((p) => p.id === projectId)?.progressPct).toBe(50);
  });

  it('reports 0 for a project with no tasks', async () => {
    const admin = await register('admin@example.com');
    const teamId = await createTeam(admin.token, 'team-a');
    const projectId = await createProject(admin.token, teamId, 'Empty');

    const rows = await listAll(admin.token);
    expect(rows.find((p) => p.id === projectId)?.progressPct).toBe(0);
  });

  it('excludes soft-deleted tasks', async () => {
    const admin = await register('admin@example.com');
    const teamId = await createTeam(admin.token, 'team-a');
    const projectId = await createProject(admin.token, teamId, 'P1');

    await createTask(admin.token, teamId, projectId, 'live-a', 100);
    await createTask(admin.token, teamId, projectId, 'live-b', 0);
    const doomed = await createTask(admin.token, teamId, projectId, 'deleted', 0);

    // Without the deletedAt filter this would average to 33, not 50.
    await prisma.task.update({ where: { id: doomed }, data: { deletedAt: new Date() } });

    const rows = await listAll(admin.token);
    expect(rows.find((p) => p.id === projectId)?.progressPct).toBe(50);
  });

  it('excludes summary tasks so rollups are not double counted', async () => {
    const admin = await register('admin@example.com');
    const teamId = await createTeam(admin.token, 'team-a');
    const projectId = await createProject(admin.token, teamId, 'P1');

    await createTask(admin.token, teamId, projectId, 'leaf-a', 100);
    await createTask(admin.token, teamId, projectId, 'leaf-b', 0);
    const summary = await createTask(admin.token, teamId, projectId, 'summary', 100);

    // Without the isSummary filter this would average to 67, not 50.
    await prisma.task.update({ where: { id: summary }, data: { isSummary: true } });

    const rows = await listAll(admin.token);
    expect(rows.find((p) => p.id === projectId)?.progressPct).toBe(50);
  });

  it('rounds to a whole percent', async () => {
    const admin = await register('admin@example.com');
    const teamId = await createTeam(admin.token, 'team-a');
    const projectId = await createProject(admin.token, teamId, 'P1');

    // 200 / 3 = 66.67 → 67
    await createTask(admin.token, teamId, projectId, 'a', 100);
    await createTask(admin.token, teamId, projectId, 'b', 100);
    await createTask(admin.token, teamId, projectId, 'c', 0);

    const rows = await listAll(admin.token);
    expect(rows.find((p) => p.id === projectId)?.progressPct).toBe(67);
  });

  it('scopes progress per project, not across the whole response', async () => {
    const admin = await register('admin@example.com');
    const teamId = await createTeam(admin.token, 'team-a');
    const done = await createProject(admin.token, teamId, 'Done');
    const fresh = await createProject(admin.token, teamId, 'Fresh');

    await createTask(admin.token, teamId, done, 'a', 100);
    await createTask(admin.token, teamId, fresh, 'b', 0);

    const rows = await listAll(admin.token);
    expect(rows.find((p) => p.id === done)?.progressPct).toBe(100);
    expect(rows.find((p) => p.id === fresh)?.progressPct).toBe(0);
  });

  it('every row satisfies the response schema (int, 0..100)', async () => {
    const admin = await register('admin@example.com');
    const teamId = await createTeam(admin.token, 'team-a');
    const projectId = await createProject(admin.token, teamId, 'P1');
    await createTask(admin.token, teamId, projectId, 'a', 42);

    const rows = await listAll(admin.token);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Number.isInteger(row.progressPct)).toBe(true);
      expect(row.progressPct).toBeGreaterThanOrEqual(0);
      expect(row.progressPct).toBeLessThanOrEqual(100);
    }
  });

  it('does not leak another team’s project or its progress', async () => {
    const owner = await register('owner@example.com');
    const teamId = await createTeam(owner.token, 'team-a');
    const secret = await createProject(owner.token, teamId, 'Secret');
    await createTask(owner.token, teamId, secret, 'a', 100);

    const outsider = await register('outsider@example.com', 'MEMBER');
    const rows = await listAll(outsider.token);
    expect(rows.find((p) => p.id === secret)).toBeUndefined();
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { createDueDateScheduler } from '../../src/scheduler/dueDateScheduler.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';

// v2.5.28 (StandaloneTask, Option C): personal tasks — CRUD, owner isolation,
// promote, reorder, DONE completedAt, dueDate reset, and the scheduler branch.

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
  if (app) await app.close();
});

beforeEach(async () => {
  await prisma.refreshToken.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.standaloneTask.deleteMany();
  await prisma.task.deleteMany();
  await prisma.project.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
});

const PASSWORD = 'CorrectHorseBattery9';
const H = (t: string) => ({ authorization: `Bearer ${t}` });
const inject = (o: Parameters<FastifyInstance['inject']>[0]) => app.inject(o);

const BASE = '/api/me/standalone-tasks';

async function createTask(token: string, payload: Record<string, unknown> = {}) {
  return inject({ method: 'POST', url: BASE, headers: H(token), payload: { title: 'Personal', ...payload } });
}

function fakeLogger() {
  const l = {
    info: () => {}, error: () => {}, warn: () => {}, debug: () => {}, trace: () => {},
    fatal: () => {}, silent: () => {}, level: 'silent', child: () => l,
  };
  return l as unknown as Parameters<typeof createDueDateScheduler>[0]['logger'];
}

describe('StandaloneTask CRUD + lifecycle', () => {
  it('creates, lists, updates, and completes a personal task', async () => {
    const a = await bootstrapUser(app, { email: 'a@ex.com', password: PASSWORD });
    const created = await createTask(a.token, { priority: 'HIGH' });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    expect(created.json().status).toBe('TODO');

    const list = await inject({ method: 'GET', url: BASE, headers: H(a.token) });
    expect(list.json().items).toHaveLength(1);

    // DONE sets completedAt.
    const done = await inject({
      method: 'PATCH', url: `${BASE}/${id}`, headers: H(a.token), payload: { status: 'DONE' },
    });
    expect(done.json().status).toBe('DONE');
    expect(done.json().completedAt).not.toBeNull();

    // Back to TODO clears completedAt.
    const reopen = await inject({
      method: 'PATCH', url: `${BASE}/${id}`, headers: H(a.token), payload: { status: 'TODO' },
    });
    expect(reopen.json().completedAt).toBeNull();
  });

  it('soft-deletes and restores', async () => {
    const a = await bootstrapUser(app, { email: 'a@ex.com', password: PASSWORD });
    const id = (await createTask(a.token)).json().id;

    const del = await inject({ method: 'DELETE', url: `${BASE}/${id}`, headers: H(a.token) });
    expect(del.statusCode).toBe(204);
    // Gone from the active list, present in the deleted scope.
    expect((await inject({ method: 'GET', url: BASE, headers: H(a.token) })).json().items).toHaveLength(0);
    const deleted = await inject({ method: 'GET', url: `${BASE}?scope=deleted`, headers: H(a.token) });
    expect(deleted.json().items).toHaveLength(1);

    const restore = await inject({ method: 'POST', url: `${BASE}/${id}/restore`, headers: H(a.token) });
    expect(restore.statusCode).toBe(200);
    expect((await inject({ method: 'GET', url: BASE, headers: H(a.token) })).json().items).toHaveLength(1);
  });

  it('reorders within a status column to dense sortOrder', async () => {
    const a = await bootstrapUser(app, { email: 'a@ex.com', password: PASSWORD });
    const ids = [];
    for (const title of ['t1', 't2', 't3']) ids.push((await createTask(a.token, { title })).json().id);

    const reversed = [...ids].reverse();
    const res = await inject({
      method: 'POST', url: `${BASE}/reorder`, headers: H(a.token),
      payload: { status: 'TODO', orderedIds: reversed },
    });
    expect(res.statusCode).toBe(200);
    const ordered = res.json().items.map((x: { id: string; sortOrder: number }) => x.id);
    expect(ordered).toEqual(reversed);
    const sorts = res.json().items.map((x: { sortOrder: number }) => x.sortOrder);
    expect(sorts).toEqual([0, 1, 2]);
  });

  it('resets the due-reminder marker when dueDate changes', async () => {
    const a = await bootstrapUser(app, { email: 'a@ex.com', password: PASSWORD });
    const id = (await createTask(a.token, { dueDate: '2026-08-01T00:00:00.000Z' })).json().id;
    // Simulate a prior reminder emission.
    await prisma.standaloneTask.update({ where: { id }, data: { lastDueNotifiedAt: new Date() } });

    await inject({
      method: 'PATCH', url: `${BASE}/${id}`, headers: H(a.token),
      payload: { dueDate: '2026-09-01T00:00:00.000Z' },
    });
    const row = await prisma.standaloneTask.findUnique({ where: { id } });
    expect(row!.lastDueNotifiedAt).toBeNull();
  });
});

describe('StandaloneTask owner isolation', () => {
  it('user B gets 404 on user A\'s task for every endpoint', async () => {
    const a = await bootstrapUser(app, { email: 'a@ex.com', password: PASSWORD });
    const b = await bootstrapUser(app, { email: 'b@ex.com', password: PASSWORD, globalRole: 'MEMBER' });
    const id = (await createTask(a.token)).json().id;

    // B never sees A's task.
    expect((await inject({ method: 'GET', url: BASE, headers: H(b.token) })).json().items).toHaveLength(0);

    const patch = await inject({ method: 'PATCH', url: `${BASE}/${id}`, headers: H(b.token), payload: { title: 'x' } });
    expect(patch.statusCode).toBe(404);
    expect(patch.json().error.code).toBe('STANDALONE_TASK_NOT_FOUND');

    const del = await inject({ method: 'DELETE', url: `${BASE}/${id}`, headers: H(b.token) });
    expect(del.statusCode).toBe(404);
    const restore = await inject({ method: 'POST', url: `${BASE}/${id}/restore`, headers: H(b.token) });
    expect(restore.statusCode).toBe(404);
    const promote = await inject({
      method: 'POST', url: `${BASE}/${id}/promote`, headers: H(b.token), payload: { projectId: 'nope' },
    });
    expect(promote.statusCode).toBe(404);
  });
});

describe('StandaloneTask promote (D8)', () => {
  async function makeProject(token: string) {
    const team = (await inject({ method: 'POST', url: '/api/teams', headers: H(token), payload: { name: 'T', slug: 'promo-team' } })).json();
    const project = (await inject({ method: 'POST', url: `/api/teams/${team.id}/projects`, headers: H(token), payload: { name: 'P' } })).json();
    return { teamId: team.id, projectId: project.id };
  }

  it('promotes to a real task with WRITE access, then soft-deletes the standalone', async () => {
    const a = await bootstrapUser(app, { email: 'a@ex.com', password: PASSWORD });
    const { projectId } = await makeProject(a.token);
    const id = (await createTask(a.token, { title: 'Draft doc', priority: 'HIGH' })).json().id;

    const res = await inject({
      method: 'POST', url: `${BASE}/${id}/promote`, headers: H(a.token), payload: { projectId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().warning).toBeNull();

    // A real task now exists in the project.
    expect(await prisma.task.count({ where: { projectId, title: 'Draft doc' } })).toBe(1);
    // Standalone was soft-deleted and linked.
    const row = await prisma.standaloneTask.findUnique({ where: { id } });
    expect(row!.deletedAt).not.toBeNull();
    expect(row!.promotedTaskId).toBeTruthy();
  });

  it('denies promote without project access (existence-hiding 404)', async () => {
    const a = await bootstrapUser(app, { email: 'a@ex.com', password: PASSWORD });
    const b = await bootstrapUser(app, { email: 'b@ex.com', password: PASSWORD, globalRole: 'MEMBER' });
    const { projectId } = await makeProject(a.token); // A's project, B has no access.
    const id = (await createTask(b.token, { title: 'mine' })).json().id;

    const res = await inject({
      method: 'POST', url: `${BASE}/${id}/promote`, headers: H(b.token), payload: { projectId },
    });
    expect(res.statusCode).toBe(404);
    // The standalone task is untouched (not promoted).
    const row = await prisma.standaloneTask.findUnique({ where: { id } });
    expect(row!.deletedAt).toBeNull();
    expect(row!.promotedTaskId).toBeNull();
  });
});

describe('StandaloneTask due scheduler (D5)', () => {
  it('emits STANDALONE_TASK_DUE once, respecting the lead window', async () => {
    const a = await bootstrapUser(app, { email: 'a@ex.com', password: PASSWORD });
    const dueSoon = new Date(Date.now() + 12 * 60 * 60 * 1000);
    const id = (await createTask(a.token, { dueDate: dueSoon.toISOString() })).json().id;

    const scheduler = createDueDateScheduler({ defaultLeadHours: 24, intervalMin: 9999, logger: fakeLogger() });
    expect(await scheduler.runOnce()).toBe(1);

    const inbox = (await inject({ method: 'GET', url: '/api/notifications', headers: H(a.token) })).json() as Array<{
      type: string; payload: Record<string, unknown>;
    }>;
    const row = inbox.find((n) => n.type === 'STANDALONE_TASK_DUE');
    expect(row).toBeTruthy();
    expect(row!.payload.standaloneTaskId).toBe(id);

    // Idempotent: a second tick emits nothing.
    expect(await scheduler.runOnce()).toBe(0);
  });

  it('does not emit for a DONE personal task', async () => {
    const a = await bootstrapUser(app, { email: 'a@ex.com', password: PASSWORD });
    const dueSoon = new Date(Date.now() + 6 * 60 * 60 * 1000);
    const id = (await createTask(a.token, { dueDate: dueSoon.toISOString() })).json().id;
    await inject({ method: 'PATCH', url: `${BASE}/${id}`, headers: H(a.token), payload: { status: 'DONE' } });

    const scheduler = createDueDateScheduler({ defaultLeadHours: 24, intervalMin: 9999, logger: fakeLogger() });
    expect(await scheduler.runOnce()).toBe(0);
  });
});

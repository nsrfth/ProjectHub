import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';

// v1.81: one-page per-project status report.

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
  await prisma.task.deleteMany();
  await prisma.project.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
});

const PASSWORD = 'CorrectHorseBattery9';
function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}
async function register(email: string, globalRole: 'ADMIN' | 'MEMBER') {
  const r = await bootstrapUser(app, { email, name: email.split('@')[0], password: PASSWORD, globalRole });
  return { token: r.token, userId: r.userId, name: email.split('@')[0] };
}
async function createTeam(token: string, slug: string): Promise<{ id: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/teams', headers: auth(token), payload: { name: slug, slug } });
  if (res.statusCode !== 201) throw new Error(`createTeam ${res.statusCode} ${res.body}`);
  return res.json() as { id: string };
}
async function addMember(adminToken: string, teamId: string, email: string, role: 'MEMBER' | 'MANAGER') {
  const res = await app.inject({ method: 'POST', url: `/api/teams/${teamId}/members`, headers: auth(adminToken), payload: { email, role } });
  if (res.statusCode !== 201) throw new Error(`addMember ${res.statusCode} ${res.body}`);
}
async function createProject(token: string, teamId: string, payload: Record<string, unknown>): Promise<{ id: string }> {
  const res = await app.inject({ method: 'POST', url: `/api/teams/${teamId}/projects`, headers: auth(token), payload: { name: 'P', ...payload } });
  if (res.statusCode !== 201) throw new Error(`createProject ${res.statusCode} ${res.body}`);
  return res.json() as { id: string };
}
async function createTask(token: string, teamId: string, projectId: string, title: string): Promise<{ id: string }> {
  const res = await app.inject({ method: 'POST', url: `/api/teams/${teamId}/projects/${projectId}/tasks`, headers: auth(token), payload: { title } });
  if (res.statusCode !== 201) throw new Error(`createTask ${res.statusCode} ${res.body}`);
  return res.json() as { id: string };
}
async function patchTask(token: string, teamId: string, projectId: string, taskId: string, body: Record<string, unknown>) {
  const res = await app.inject({ method: 'PATCH', url: `/api/teams/${teamId}/projects/${projectId}/tasks/${taskId}`, headers: auth(token), payload: body });
  if (res.statusCode !== 200) throw new Error(`patchTask ${res.statusCode} ${res.body}`);
}
function getStatus(token: string, teamId: string, projectId: string) {
  return app.inject({ method: 'GET', url: `/api/teams/${teamId}/projects/${projectId}/reports/status`, headers: auth(token) });
}
function yesterdayIso(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString();
}

describe('GET project status report', () => {
  it('reports correct counts, % complete, overdue, budget, and owner/accountable', async () => {
    const admin = await register('admin@x.com', 'ADMIN');
    const acc = await register('acc@x.com', 'MEMBER');
    const team = await createTeam(admin.token, 'team-a');
    await addMember(admin.token, team.id, 'acc@x.com', 'MEMBER');
    const project = await createProject(admin.token, team.id, {
      accountableId: acc.userId,
      plannedBudget: '5000',
      budgetCurrency: 'USD',
    });

    const t1 = await createTask(admin.token, team.id, project.id, 'done1');
    const t2 = await createTask(admin.token, team.id, project.id, 'done2');
    const t3 = await createTask(admin.token, team.id, project.id, 'wip-overdue');
    await createTask(admin.token, team.id, project.id, 'todo');
    // 2 done (one with a past due — must NOT count as overdue), 1 in-progress overdue, 1 todo.
    await patchTask(admin.token, team.id, project.id, t1.id, { status: 'DONE', dueDate: yesterdayIso(), statusComment: 'done (test)' });
    await patchTask(admin.token, team.id, project.id, t2.id, { status: 'DONE', statusComment: 'done (test)' });
    await patchTask(admin.token, team.id, project.id, t3.id, { status: 'IN_PROGRESS', dueDate: yesterdayIso() });

    const res = await getStatus(admin.token, team.id, project.id);
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.taskCounts).toEqual({ todo: 1, inProgress: 1, review: 0, done: 2, total: 4 });
    expect(b.percentComplete).toBe(50);
    expect(b.overdueCount).toBe(1); // only the non-DONE past-due task
    expect(b.plannedBudget).toBe('5000.00');
    expect(b.budgetCurrency).toBe('USD');
    expect(b.ownerName).toBe('admin');
    expect(b.accountableName).toBe('acc');
    expect(b.status).toBe('ACTIVE');
  });

  it('handles a project with zero tasks (0% complete, no NaN)', async () => {
    const admin = await register('admin@x.com', 'ADMIN');
    const team = await createTeam(admin.token, 'team-a');
    const project = await createProject(admin.token, team.id, {});

    const res = await getStatus(admin.token, team.id, project.id);
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.taskCounts).toEqual({ todo: 0, inProgress: 0, review: 0, done: 0, total: 0 });
    expect(b.percentComplete).toBe(0);
    expect(b.overdueCount).toBe(0);
    expect(Number.isNaN(b.percentComplete)).toBe(false);
  });

  it('returns null owner/accountable and budget when unset', async () => {
    const admin = await register('admin@x.com', 'ADMIN');
    const team = await createTeam(admin.token, 'team-a');
    // Project owned by admin but no accountable, no budget.
    const project = await createProject(admin.token, team.id, {});
    const res = await getStatus(admin.token, team.id, project.id);
    const b = res.json();
    expect(b.ownerName).toBe('admin'); // creator is owner
    expect(b.accountableName).toBeNull();
    expect(b.plannedBudget).toBeNull();
  });

  it('returns 404 for a member who cannot access the project (no leak)', async () => {
    const admin = await register('admin@x.com', 'ADMIN');
    const member = await register('member@x.com', 'MEMBER');
    const team = await createTeam(admin.token, 'team-a');
    await addMember(admin.token, team.id, 'member@x.com', 'MEMBER');
    const project = await createProject(admin.token, team.id, {}); // owned by admin

    const res = await getStatus(member.token, team.id, project.id);
    expect(res.statusCode).toBe(404);
  });
});

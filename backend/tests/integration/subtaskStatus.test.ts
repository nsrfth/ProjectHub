import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';

// v1.82: subtask progress status + responsible/assignee status-only edit rights.

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
  await prisma.subtask.deleteMany();
  await prisma.task.deleteMany();
  await prisma.project.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.team.deleteMany(); // cascades UserGroup / grants
  await prisma.user.deleteMany();
});

const PASSWORD = 'CorrectHorseBattery9';
const A = (token: string) => ({ authorization: `Bearer ${token}` });

async function register(email: string, globalRole: 'ADMIN' | 'MEMBER') {
  const r = await bootstrapUser(app, { email, name: email.split('@')[0], password: PASSWORD, globalRole });
  return { token: r.token, userId: r.userId };
}
async function createTeam(token: string, slug: string): Promise<{ id: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/teams', headers: A(token), payload: { name: slug, slug } });
  if (res.statusCode !== 201) throw new Error(`createTeam ${res.statusCode} ${res.body}`);
  return res.json() as { id: string };
}
async function addMember(adminToken: string, teamId: string, email: string, role: 'MEMBER' | 'MANAGER') {
  const res = await app.inject({ method: 'POST', url: `/api/teams/${teamId}/members`, headers: A(adminToken), payload: { email, role } });
  if (res.statusCode !== 201) throw new Error(`addMember ${res.statusCode} ${res.body}`);
}
async function createProject(token: string, teamId: string): Promise<{ id: string }> {
  const res = await app.inject({ method: 'POST', url: `/api/teams/${teamId}/projects`, headers: A(token), payload: { name: 'P' } });
  if (res.statusCode !== 201) throw new Error(`createProject ${res.statusCode} ${res.body}`);
  return res.json() as { id: string };
}
async function createTask(token: string, teamId: string, projectId: string): Promise<{ id: string }> {
  const res = await app.inject({ method: 'POST', url: `/api/teams/${teamId}/projects/${projectId}/tasks`, headers: A(token), payload: { title: 'T' } });
  if (res.statusCode !== 201) throw new Error(`createTask ${res.statusCode} ${res.body}`);
  return res.json() as { id: string };
}
async function createSubtask(token: string, teamId: string, projectId: string, taskId: string, body: Record<string, unknown> = {}) {
  return app.inject({ method: 'POST', url: `/api/teams/${teamId}/projects/${projectId}/tasks/${taskId}/subtasks`, headers: A(token), payload: { title: 'S', ...body } });
}
function patchSubtask(token: string, teamId: string, projectId: string, taskId: string, subtaskId: string, body: Record<string, unknown>) {
  return app.inject({ method: 'PATCH', url: `/api/teams/${teamId}/projects/${projectId}/tasks/${taskId}/subtasks/${subtaskId}`, headers: A(token), payload: body });
}
function setStatus(token: string, teamId: string, projectId: string, taskId: string, subtaskId: string, status: string) {
  return app.inject({ method: 'PATCH', url: `/api/teams/${teamId}/projects/${projectId}/tasks/${taskId}/subtasks/${subtaskId}/status`, headers: A(token), payload: { status } });
}
function getTask(token: string, teamId: string, projectId: string, taskId: string) {
  return app.inject({ method: 'GET', url: `/api/teams/${teamId}/projects/${projectId}/tasks/${taskId}`, headers: A(token) });
}
async function grantReadonly(teamId: string, projectId: string, userId: string): Promise<void> {
  const group = await prisma.userGroup.create({ data: { teamId, name: `g-${userId}` } });
  await prisma.userGroupMember.create({ data: { groupId: group.id, userId, accessLevel: 'READONLY', status: 'ACCEPTED' } });
  await prisma.projectGroupGrant.create({ data: { projectId, groupId: group.id } });
}

describe('subtask progress status', () => {
  it('defaults a new subtask to NOT_STARTED + done=false', async () => {
    const admin = await register('admin@x.com', 'ADMIN');
    const team = await createTeam(admin.token, 'team-a');
    const project = await createProject(admin.token, team.id);
    const task = await createTask(admin.token, team.id, project.id);
    const res = await createSubtask(admin.token, team.id, project.id, task.id);
    expect(res.statusCode).toBe(201);
    const s = res.json();
    expect(s.status).toBe('NOT_STARTED');
    expect(s.done).toBe(false);
  });

  it('keeps done and status in sync via the status endpoint', async () => {
    const admin = await register('admin@x.com', 'ADMIN');
    const team = await createTeam(admin.token, 'team-a');
    const project = await createProject(admin.token, team.id);
    const task = await createTask(admin.token, team.id, project.id);
    const sub = (await createSubtask(admin.token, team.id, project.id, task.id)).json() as { id: string };

    const r1 = await setStatus(admin.token, team.id, project.id, task.id, sub.id, 'DONE');
    expect(r1.statusCode).toBe(200);
    expect(r1.json().status).toBe('DONE');
    expect(r1.json().done).toBe(true);

    const r2 = await setStatus(admin.token, team.id, project.id, task.id, sub.id, 'WAITING');
    expect(r2.json().status).toBe('WAITING');
    expect(r2.json().done).toBe(false); // never diverges
  });

  it('legacy done toggle (full PATCH) still works and syncs status', async () => {
    const admin = await register('admin@x.com', 'ADMIN');
    const team = await createTeam(admin.token, 'team-a');
    const project = await createProject(admin.token, team.id);
    const task = await createTask(admin.token, team.id, project.id);
    const sub = (await createSubtask(admin.token, team.id, project.id, task.id)).json() as { id: string };

    const on = await patchSubtask(admin.token, team.id, project.id, task.id, sub.id, { done: true });
    expect(on.json().status).toBe('DONE');
    expect(on.json().done).toBe(true);

    const off = await patchSubtask(admin.token, team.id, project.id, task.id, sub.id, { done: false });
    expect(off.json().status).toBe('NOT_STARTED');
    expect(off.json().done).toBe(false);
  });

  it("lets the subtask's assignee change status without full edit permission", async () => {
    const admin = await register('admin@x.com', 'ADMIN');
    const u = await register('u@x.com', 'MEMBER');
    const team = await createTeam(admin.token, 'team-a');
    await addMember(admin.token, team.id, 'u@x.com', 'MEMBER');
    const project = await createProject(admin.token, team.id); // owned by admin
    await grantReadonly(team.id, project.id, u.userId); // u: project READ only
    const task = await createTask(admin.token, team.id, project.id);
    // admin (WRITE) makes u the assignee
    const sub = (await createSubtask(admin.token, team.id, project.id, task.id, { assigneeId: u.userId })).json() as { id: string };

    const res = await setStatus(u.token, team.id, project.id, task.id, sub.id, 'IN_PROGRESS');
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('IN_PROGRESS');
  });

  it("lets the subtask's responsible change status without full edit permission", async () => {
    const admin = await register('admin@x.com', 'ADMIN');
    const u = await register('u@x.com', 'MEMBER');
    const team = await createTeam(admin.token, 'team-a');
    await addMember(admin.token, team.id, 'u@x.com', 'MEMBER');
    const project = await createProject(admin.token, team.id);
    await grantReadonly(team.id, project.id, u.userId);
    const task = await createTask(admin.token, team.id, project.id);
    const sub = (await createSubtask(admin.token, team.id, project.id, task.id)).json() as { id: string };
    // admin (ADMIN → task.change_responsible) sets u as responsible
    await patchSubtask(admin.token, team.id, project.id, task.id, sub.id, { responsibleId: u.userId });

    const res = await setStatus(u.token, team.id, project.id, task.id, sub.id, 'DEFERRED');
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('DEFERRED');
  });

  it('does NOT let a read-only assignee edit other subtask fields (status-only)', async () => {
    const admin = await register('admin@x.com', 'ADMIN');
    const u = await register('u@x.com', 'MEMBER');
    const team = await createTeam(admin.token, 'team-a');
    await addMember(admin.token, team.id, 'u@x.com', 'MEMBER');
    const project = await createProject(admin.token, team.id);
    await grantReadonly(team.id, project.id, u.userId);
    const task = await createTask(admin.token, team.id, project.id);
    const sub = (await createSubtask(admin.token, team.id, project.id, task.id, { assigneeId: u.userId })).json() as { id: string };

    // Full PATCH (title) requires project WRITE — u has READ only → 403.
    const res = await patchSubtask(u.token, team.id, project.id, task.id, sub.id, { title: 'hacked' });
    expect(res.statusCode).toBe(403);
  });

  it('denies status change to a read-only user who is neither responsible nor assignee', async () => {
    const admin = await register('admin@x.com', 'ADMIN');
    const v = await register('v@x.com', 'MEMBER');
    const team = await createTeam(admin.token, 'team-a');
    await addMember(admin.token, team.id, 'v@x.com', 'MEMBER');
    const project = await createProject(admin.token, team.id);
    await grantReadonly(team.id, project.id, v.userId); // read access, but no role on the subtask
    const task = await createTask(admin.token, team.id, project.id);
    const sub = (await createSubtask(admin.token, team.id, project.id, task.id)).json() as { id: string };

    const res = await setStatus(v.token, team.id, project.id, task.id, sub.id, 'IN_PROGRESS');
    expect(res.statusCode).toBe(403);
  });

  it('surfaces subtask status in the task response', async () => {
    const admin = await register('admin@x.com', 'ADMIN');
    const team = await createTeam(admin.token, 'team-a');
    const project = await createProject(admin.token, team.id);
    const task = await createTask(admin.token, team.id, project.id);
    const sub = (await createSubtask(admin.token, team.id, project.id, task.id)).json() as { id: string };
    await setStatus(admin.token, team.id, project.id, task.id, sub.id, 'WAITING');

    const res = await getTask(admin.token, team.id, project.id, task.id);
    expect(res.statusCode).toBe(200);
    const t = res.json() as { subtasks: Array<{ id: string; status: string; done: boolean }> };
    const row = t.subtasks.find((s) => s.id === sub.id)!;
    expect(row.status).toBe('WAITING');
    expect(row.done).toBe(false);
  });
});

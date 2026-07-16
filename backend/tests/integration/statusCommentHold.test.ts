import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';

// v2.5.58: ON_HOLD status + mandatory status comments.
//   - moving a task INTO ON_HOLD requires `statusComment` (400 STATUS_COMMENT_REQUIRED)
//   - requesting DONE requires `statusComment` (audit trail), on BOTH the PATCH
//     and the drag-and-drop reorder endpoint
//   - the comment is persisted as a REAL Comment row in the same transaction
//   - exits from ON_HOLD and other transitions stay comment-free
//   - the v1.87 approval reroute still captures the completion comment

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

async function register(email: string, globalRole: 'ADMIN' | 'MEMBER') {
  const r = await bootstrapUser(app, { email, name: email.split('@')[0], password: PASSWORD, globalRole });
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

async function createProject(token: string, teamId: string, name = 'P1'): Promise<string> {
  const r = await app.inject({
    method: 'POST',
    url: `/api/teams/${teamId}/projects`,
    headers: { authorization: `Bearer ${token}` },
    payload: { name },
  });
  if (r.statusCode !== 201) throw new Error(`createProject failed: ${r.statusCode} ${r.body}`);
  return r.json().id as string;
}

async function addMember(
  adminToken: string,
  teamId: string,
  email: string,
  role: 'MEMBER' | 'MANAGER',
): Promise<void> {
  const r = await app.inject({
    method: 'POST',
    url: `/api/teams/${teamId}/members`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { email, role },
  });
  if (r.statusCode !== 201) throw new Error(`addMember failed: ${r.statusCode} ${r.body}`);
}

async function createTask(
  token: string,
  teamId: string,
  projectId: string,
  payload: Record<string, unknown> = {},
): Promise<string> {
  const r = await app.inject({
    method: 'POST',
    url: `/api/teams/${teamId}/projects/${projectId}/tasks`,
    headers: { authorization: `Bearer ${token}` },
    payload: { title: 'T', ...payload },
  });
  if (r.statusCode !== 201) throw new Error(`createTask failed: ${r.statusCode} ${r.body}`);
  return r.json().id as string;
}

function patchTask(
  token: string,
  teamId: string,
  projectId: string,
  taskId: string,
  payload: Record<string, unknown>,
) {
  return app.inject({
    method: 'PATCH',
    url: `/api/teams/${teamId}/projects/${projectId}/tasks/${taskId}`,
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}

function listComments(token: string, teamId: string, projectId: string, taskId: string) {
  return app.inject({
    method: 'GET',
    url: `/api/teams/${teamId}/projects/${projectId}/tasks/${taskId}/comments`,
    headers: { authorization: `Bearer ${token}` },
  });
}

describe('ON_HOLD + mandatory status comments (v2.5.58)', () => {
  it('rejects moving into ON_HOLD without a comment, accepts with one, and stores a real Comment row', async () => {
    const admin = await register('admin@x.com', 'ADMIN');
    const teamId = await createTeam(admin.token, 'alpha');
    const projectId = await createProject(admin.token, teamId);
    const taskId = await createTask(admin.token, teamId, projectId);

    const missing = await patchTask(admin.token, teamId, projectId, taskId, { status: 'ON_HOLD' });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe('STATUS_COMMENT_REQUIRED');
    expect(missing.json().error.details.requiredFor).toBe('ON_HOLD');

    const ok = await patchTask(admin.token, teamId, projectId, taskId, {
      status: 'ON_HOLD',
      statusComment: 'Waiting on vendor quote',
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe('ON_HOLD');

    const comments = await listComments(admin.token, teamId, projectId, taskId);
    expect(comments.statusCode).toBe(200);
    const bodies = comments.json().map((c: { body: string }) => c.body);
    expect(bodies).toContain('Waiting on vendor quote');

    const acts = await prisma.activity.findMany({ where: { taskId } });
    const actions = acts.map((a) => a.action);
    expect(actions).toContain('task.status_changed');
    expect(actions).toContain('comment.added');
  });

  it('leaving ON_HOLD is comment-free; other transitions stay free too', async () => {
    const admin = await register('admin@x.com', 'ADMIN');
    const teamId = await createTeam(admin.token, 'alpha');
    const projectId = await createProject(admin.token, teamId);
    const taskId = await createTask(admin.token, teamId, projectId);

    await patchTask(admin.token, teamId, projectId, taskId, {
      status: 'ON_HOLD',
      statusComment: 'blocked',
    });
    const resume = await patchTask(admin.token, teamId, projectId, taskId, { status: 'IN_PROGRESS' });
    expect(resume.statusCode).toBe(200);
    expect(resume.json().status).toBe('IN_PROGRESS');

    const review = await patchTask(admin.token, teamId, projectId, taskId, { status: 'REVIEW' });
    expect(review.statusCode).toBe(200);
  });

  it('requires a completion comment for DONE on both PATCH and reorder; auto-fills completedAt', async () => {
    const admin = await register('admin@x.com', 'ADMIN');
    const teamId = await createTeam(admin.token, 'alpha');
    const projectId = await createProject(admin.token, teamId);
    const t1 = await createTask(admin.token, teamId, projectId);
    const t2 = await createTask(admin.token, teamId, projectId, { title: 'T2' });

    const missing = await patchTask(admin.token, teamId, projectId, t1, { status: 'DONE' });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe('STATUS_COMMENT_REQUIRED');
    expect(missing.json().error.details.requiredFor).toBe('DONE');

    const done = await patchTask(admin.token, teamId, projectId, t1, {
      status: 'DONE',
      statusComment: 'Implemented and deployed',
    });
    expect(done.statusCode).toBe(200);
    expect(done.json().status).toBe('DONE');
    expect(done.json().completedAt).toBeTruthy();

    // Drag-and-drop path.
    const reorderMissing = await app.inject({
      method: 'POST',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks/${t2}/reorder`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { status: 'DONE', beforeTaskId: null },
    });
    expect(reorderMissing.statusCode).toBe(400);
    expect(reorderMissing.json().error.code).toBe('STATUS_COMMENT_REQUIRED');

    const reorderOk = await app.inject({
      method: 'POST',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks/${t2}/reorder`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { status: 'DONE', beforeTaskId: null, statusComment: 'Finished during triage' },
    });
    expect(reorderOk.statusCode).toBe(200);
    expect(reorderOk.json().status).toBe('DONE');

    const comments = await listComments(admin.token, teamId, projectId, t2);
    expect(comments.json().map((c: { body: string }) => c.body)).toContain('Finished during triage');
  });

  it('captures the completion comment even when DONE is rerouted to PENDING_APPROVAL', async () => {
    const admin = await register('admin@x.com', 'ADMIN');
    const owner = await register('owner@x.com', 'MEMBER');
    const teamId = await createTeam(admin.token, 'alpha');
    await addMember(admin.token, teamId, 'owner@x.com', 'MEMBER');
    // Owner (plain MEMBER) creates the project → WRITE via ownership, but NOT
    // an approval finalizer (not manager/admin/approver/delegate).
    const projectId = await createProject(owner.token, teamId);
    const taskId = await createTask(owner.token, teamId, projectId, {
      requiresApproval: true,
      approverId: admin.userId,
    });

    const missing = await patchTask(owner.token, teamId, projectId, taskId, { status: 'DONE' });
    expect(missing.statusCode).toBe(400);

    const claimed = await patchTask(owner.token, teamId, projectId, taskId, {
      status: 'DONE',
      statusComment: 'All subtasks delivered',
    });
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json().status).toBe('PENDING_APPROVAL');

    const comments = await listComments(owner.token, teamId, projectId, taskId);
    expect(comments.json().map((c: { body: string }) => c.body)).toContain('All subtasks delivered');

    // Approving afterwards needs no extra comment (approval is its own audit).
    const approve = await app.inject({
      method: 'POST',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks/${taskId}/approve`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().status).toBe('DONE');
  });

  it('negative authorization: another team’s user cannot reach the task at all', async () => {
    const admin = await register('admin@x.com', 'ADMIN');
    const outsider = await register('outsider@x.com', 'MEMBER');
    const teamId = await createTeam(admin.token, 'alpha');
    const projectId = await createProject(admin.token, teamId);
    const taskId = await createTask(admin.token, teamId, projectId);

    const r = await patchTask(outsider.token, teamId, projectId, taskId, {
      status: 'ON_HOLD',
      statusComment: 'nope',
    });
    expect([403, 404]).toContain(r.statusCode);
  });
});

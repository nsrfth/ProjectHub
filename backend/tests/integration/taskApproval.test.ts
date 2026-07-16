import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';

// v1.87 — task approval workflow.
//   - A require-approval task moved to DONE by a non-finalizer routes to
//     PENDING_APPROVAL (completedAt stays null).
//   - A finalizer (the designated approver, a team MANAGER, a global ADMIN, or a
//     full-edit delegate) moving it to DONE completes it directly.
//   - approve → DONE (+ completedAt); reject (reason required) → IN_PROGRESS.

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp(loadEnv());
});
afterAll(async () => {
  if (app) await app.close();
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
const H = (t: string) => ({ authorization: `Bearer ${t}` });

async function addMember(adminToken: string, teamId: string, email: string, role: 'MEMBER' | 'MANAGER') {
  await app.inject({
    method: 'POST', url: `/api/teams/${teamId}/members`, headers: H(adminToken), payload: { email, role },
  });
}
function createTask(token: string, teamId: string, projectId: string, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST', url: `/api/teams/${teamId}/projects/${projectId}/tasks`, headers: H(token), payload,
  });
}
function patchTask(token: string, teamId: string, projectId: string, taskId: string, body: Record<string, unknown>) {
  return app.inject({
    method: 'PATCH', url: `/api/teams/${teamId}/projects/${projectId}/tasks/${taskId}`, headers: H(token), payload: body,
  });
}
function approve(token: string, teamId: string, projectId: string, taskId: string) {
  return app.inject({
    method: 'POST', url: `/api/teams/${teamId}/projects/${projectId}/tasks/${taskId}/approve`, headers: H(token), payload: {},
  });
}
function reject(token: string, teamId: string, projectId: string, taskId: string, body: Record<string, unknown>) {
  return app.inject({
    method: 'POST', url: `/api/teams/${teamId}/projects/${projectId}/tasks/${taskId}/reject`, headers: H(token), payload: body,
  });
}

async function setup() {
  const admin = await bootstrapUser(app, { email: 'admin@example.com', name: 'Admin', password: PASSWORD, globalRole: 'ADMIN' });
  const owner = await bootstrapUser(app, { email: 'owner@example.com', name: 'Owner', password: PASSWORD, globalRole: 'MEMBER' });
  const approver = await bootstrapUser(app, { email: 'approver@example.com', name: 'Approver', password: PASSWORD, globalRole: 'MEMBER' });
  const manager = await bootstrapUser(app, { email: 'mgr@example.com', name: 'Mgr', password: PASSWORD, globalRole: 'MEMBER' });

  const team = await app.inject({ method: 'POST', url: '/api/teams', headers: H(admin.token), payload: { name: 'T', slug: 'team-a' } });
  const teamId = team.json().id as string;
  await addMember(admin.token, teamId, 'owner@example.com', 'MEMBER');
  await addMember(admin.token, teamId, 'approver@example.com', 'MANAGER'); // a manager → has project access via write_all
  await addMember(admin.token, teamId, 'mgr@example.com', 'MANAGER');

  // Cross-team user (member of a different team only).
  const team2 = await app.inject({ method: 'POST', url: '/api/teams', headers: H(admin.token), payload: { name: 'T2', slug: 'team-b' } });
  const team2Id = team2.json().id as string;
  const crossUser = await bootstrapUser(app, { email: 'cross@example.com', name: 'Cross', password: PASSWORD, globalRole: 'MEMBER' });
  await addMember(admin.token, team2Id, 'cross@example.com', 'MEMBER');

  // Project owned by `owner` (so the owner has WRITE but only MEMBER team role).
  const project = await app.inject({
    method: 'POST', url: `/api/teams/${teamId}/projects`, headers: H(admin.token), payload: { name: 'P', ownerId: owner.userId },
  });
  const projectId = project.json().id as string;

  // A require-approval task, approver = the designated MANAGER.
  const task = await createTask(admin.token, teamId, projectId, {
    title: 'Needs approval', requiresApproval: true, approverId: approver.userId,
  });
  const taskId = task.json().id as string;

  return {
    adminToken: admin.token, teamId, projectId, taskId,
    ownerToken: owner.token,
    approverToken: approver.token, approverId: approver.userId,
    managerToken: manager.token,
    crossToken: crossUser.token,
  };
}

describe('Feature — task approval workflow (v1.87)', () => {
  it('the task carries the approval config (requiresApproval + approverName)', async () => {
    const s = await setup();
    const res = await app.inject({
      method: 'GET', url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}`, headers: H(s.adminToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().requiresApproval).toBe(true);
    expect(res.json().approverId).toBe(s.approverId);
    expect(res.json().approverName).toBe('Approver');
  });

  it('a non-finalizer moving the task to DONE routes it to PENDING_APPROVAL (no completedAt)', async () => {
    const s = await setup();
    // v2.5.58: requesting DONE requires a statusComment (captured at claim
    // time even though the task lands in PENDING_APPROVAL).
    const res = await patchTask(s.ownerToken, s.teamId, s.projectId, s.taskId, { status: 'DONE', statusComment: 'done (test)' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('PENDING_APPROVAL');
    expect(res.json().completedAt).toBeNull();
  });

  it('the approver APPROVES a pending task → DONE with completedAt', async () => {
    const s = await setup();
    await patchTask(s.ownerToken, s.teamId, s.projectId, s.taskId, { status: 'DONE', statusComment: 'done (test)' });
    const res = await approve(s.approverToken, s.teamId, s.projectId, s.taskId);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('DONE');
    expect(res.json().completedAt).not.toBeNull();
  });

  it('the approver REJECTS a pending task (reason required) → IN_PROGRESS', async () => {
    const s = await setup();
    await patchTask(s.ownerToken, s.teamId, s.projectId, s.taskId, { status: 'DONE', statusComment: 'done (test)' });
    const res = await reject(s.approverToken, s.teamId, s.projectId, s.taskId, { reason: 'Needs more work' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('IN_PROGRESS');
    expect(res.json().completedAt).toBeNull();
  });

  it('NEGATIVE: rejecting without a reason is 400', async () => {
    const s = await setup();
    await patchTask(s.ownerToken, s.teamId, s.projectId, s.taskId, { status: 'DONE', statusComment: 'done (test)' });
    expect((await reject(s.approverToken, s.teamId, s.projectId, s.taskId, { reason: '' })).statusCode).toBe(400);
    expect((await reject(s.approverToken, s.teamId, s.projectId, s.taskId, {})).statusCode).toBe(400);
  });

  it('NEGATIVE: a non-finalizer with project access cannot approve (403)', async () => {
    const s = await setup();
    await patchTask(s.ownerToken, s.teamId, s.projectId, s.taskId, { status: 'DONE', statusComment: 'done (test)' });
    // The owner has WRITE access (owns the project) but is not approver/manager/admin.
    const res = await approve(s.ownerToken, s.teamId, s.projectId, s.taskId);
    expect(res.statusCode).toBe(403);
  });

  it('NEGATIVE: cannot decide a task that is not pending (400)', async () => {
    const s = await setup();
    // Task is TODO, not PENDING_APPROVAL.
    expect((await approve(s.approverToken, s.teamId, s.projectId, s.taskId)).statusCode).toBe(400);
  });

  it('BYPASS: a team MANAGER moving the task to DONE completes it directly', async () => {
    const s = await setup();
    const res = await patchTask(s.managerToken, s.teamId, s.projectId, s.taskId, { status: 'DONE', statusComment: 'done (test)' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('DONE');
    expect(res.json().completedAt).not.toBeNull();
  });

  it('NEGATIVE: a user from another team cannot touch / approve this task', async () => {
    const s = await setup();
    await patchTask(s.ownerToken, s.teamId, s.projectId, s.taskId, { status: 'DONE', statusComment: 'done (test)' });
    expect((await approve(s.crossToken, s.teamId, s.projectId, s.taskId)).statusCode).toBe(404);
    expect((await patchTask(s.crossToken, s.teamId, s.projectId, s.taskId, { status: 'TODO' })).statusCode).toBe(404);
  });
});

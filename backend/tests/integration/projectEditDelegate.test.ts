import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';

// v1.86 — Feature 3: per-project "full-edit" delegation. The owner (or a global
// ADMIN) names users who may fully edit a project's tasks/subtasks — including
// the manager-only date fields and the task.change_responsible-gated field —
// for THAT project only. Delegation grants project WRITE to the delegate but
// does NOT loosen those field gates for anyone else, and never on other projects.

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp(loadEnv());
});
afterAll(async () => {
  if (app) await app.close();
});
beforeEach(async () => {
  await prisma.refreshToken.deleteMany();
  await prisma.instanceSetting.deleteMany();
  await prisma.subtask.deleteMany();
  await prisma.task.deleteMany();
  await prisma.projectEditDelegate.deleteMany();
  await prisma.project.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
});

const PASSWORD = 'CorrectHorseBattery9';
const H = (t: string) => ({ authorization: `Bearer ${t}` });
const DUE_A = '2026-06-01T00:00:00.000Z';
const DUE_B = '2026-06-10T00:00:00.000Z';

async function addMember(adminToken: string, teamId: string, email: string, role: 'MEMBER' | 'MANAGER') {
  await app.inject({
    method: 'POST', url: `/api/teams/${teamId}/members`, headers: H(adminToken), payload: { email, role },
  });
}
function createProject(adminToken: string, teamId: string, ownerId: string, name: string) {
  return app.inject({
    method: 'POST', url: `/api/teams/${teamId}/projects`, headers: H(adminToken), payload: { name, ownerId },
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
// v1.88: grant FULL to each listed user (keeps the legacy full-edit cases valid).
function putDelegates(token: string, teamId: string, projectId: string, userIds: string[]) {
  return app.inject({
    method: 'PUT', url: `/api/teams/${teamId}/projects/${projectId}/delegates`, headers: H(token),
    payload: { delegates: userIds.map((userId) => ({ userId, capabilities: ['FULL'] })) },
  });
}

// v1.88: grant an explicit capability set to one delegate.
function putDelegateCaps(
  token: string, teamId: string, projectId: string, userId: string, capabilities: string[],
) {
  return app.inject({
    method: 'PUT', url: `/api/teams/${teamId}/projects/${projectId}/delegates`, headers: H(token),
    payload: { delegates: [{ userId, capabilities }] },
  });
}

async function setup() {
  const admin = await bootstrapUser(app, { email: 'admin@example.com', name: 'Admin', password: PASSWORD, globalRole: 'ADMIN' });
  const owner = await bootstrapUser(app, { email: 'owner@example.com', name: 'Owner', password: PASSWORD, globalRole: 'MEMBER' });
  const delegate = await bootstrapUser(app, { email: 'delegate@example.com', name: 'Delegate', password: PASSWORD, globalRole: 'MEMBER' });
  const other = await bootstrapUser(app, { email: 'other@example.com', name: 'Other', password: PASSWORD, globalRole: 'MEMBER' });
  const outsider = await bootstrapUser(app, { email: 'outsider@example.com', name: 'Outsider', password: PASSWORD, globalRole: 'MEMBER' });

  const team = await app.inject({ method: 'POST', url: '/api/teams', headers: H(admin.token), payload: { name: 'T', slug: 'team-d' } });
  const teamId = team.json().id as string;
  await addMember(admin.token, teamId, 'owner@example.com', 'MEMBER');
  await addMember(admin.token, teamId, 'delegate@example.com', 'MEMBER');
  await addMember(admin.token, teamId, 'other@example.com', 'MEMBER');

  // Cross-team user (member of a different team only).
  const team2 = await app.inject({ method: 'POST', url: '/api/teams', headers: H(admin.token), payload: { name: 'T2', slug: 'team-d2' } });
  const team2Id = team2.json().id as string;
  const crossUser = await bootstrapUser(app, { email: 'cross@example.com', name: 'Cross', password: PASSWORD, globalRole: 'MEMBER' });
  await addMember(admin.token, team2Id, 'cross@example.com', 'MEMBER');

  const p = await createProject(admin.token, teamId, owner.userId, 'P');
  const projectId = p.json().id as string;
  const p2 = await createProject(admin.token, teamId, owner.userId, 'P2');
  const project2Id = p2.json().id as string;

  // Manager-only date restriction ON, so the date gate is actually exercised.
  await app.inject({
    method: 'PUT', url: '/api/settings/instance/tasks.dateEditRestriction',
    headers: H(admin.token), payload: { value: 'manager-only' },
  });

  // Tasks (with an existing dueDate) on each project, created by admin.
  const t1 = await createTask(admin.token, teamId, projectId, { title: 'T1', dueDate: DUE_A });
  const taskId = t1.json().id as string;
  const t2 = await createTask(admin.token, teamId, project2Id, { title: 'T2', dueDate: DUE_A });
  const task2Id = t2.json().id as string;

  return {
    adminToken: admin.token, teamId, projectId, project2Id, taskId, task2Id,
    ownerToken: owner.token,
    delegateToken: delegate.token, delegateId: delegate.userId,
    otherToken: other.token, otherId: other.userId,
    outsiderId: outsider.userId,
    crossToken: crossUser.token,
  };
}

describe('Feature 3 — owner-delegated full edit of tasks/subtasks', () => {
  it('owner sets a delegate, and /delegates/me reflects it only for that user', async () => {
    const s = await setup();
    const put = await putDelegates(s.ownerToken, s.teamId, s.projectId, [s.delegateId]);
    expect(put.statusCode).toBe(200);
    expect(put.json().delegates.map((d: { userId: string }) => d.userId)).toContain(s.delegateId);

    const meYes = await app.inject({
      method: 'GET', url: `/api/teams/${s.teamId}/projects/${s.projectId}/delegates/me`, headers: H(s.delegateToken),
    });
    expect(meYes.json().isDelegate).toBe(true);

    const meNo = await app.inject({
      method: 'GET', url: `/api/teams/${s.teamId}/projects/${s.projectId}/delegates/me`, headers: H(s.otherToken),
    });
    expect(meNo.json().isDelegate).toBe(false);
  });

  // v1.88: granular capabilities — each unlocks ONLY its field group.
  it('a granular EDIT_TITLES delegate can rename a task but not change other fields', async () => {
    const s = await setup();
    const put = await putDelegateCaps(s.ownerToken, s.teamId, s.projectId, s.delegateId, ['EDIT_TITLES']);
    expect(put.statusCode).toBe(200);

    // /delegates/me reports the capability, but isDelegate=false (not FULL).
    const me = await app.inject({
      method: 'GET', url: `/api/teams/${s.teamId}/projects/${s.projectId}/delegates/me`, headers: H(s.delegateToken),
    });
    expect(me.json().isDelegate).toBe(false);
    expect(me.json().capabilities).toContain('EDIT_TITLES');

    // Rename → allowed.
    const rename = await patchTask(s.delegateToken, s.teamId, s.projectId, s.taskId, { title: 'Renamed' });
    expect(rename.statusCode).toBe(200);
    expect(rename.json().title).toBe('Renamed');

    // Everything else → 403 (no matching capability).
    const status = await patchTask(s.delegateToken, s.teamId, s.projectId, s.taskId, { status: 'IN_PROGRESS' });
    expect(status.statusCode).toBe(403);
    const date = await patchTask(s.delegateToken, s.teamId, s.projectId, s.taskId, { dueDate: DUE_B });
    expect(date.statusCode).toBe(403);
    const del = await app.inject({
      method: 'DELETE', url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}`, headers: H(s.delegateToken),
    });
    expect(del.statusCode).toBe(403);

    // And NOT on a project where they hold no capability.
    const elsewhere = await patchTask(s.delegateToken, s.teamId, s.project2Id, s.task2Id, { title: 'X' });
    expect(elsewhere.statusCode).toBe(404);
  });

  it('EDIT_DETAILS + DELETE_TASKS unlock status + delete but not titles', async () => {
    const s = await setup();
    await putDelegateCaps(s.ownerToken, s.teamId, s.projectId, s.delegateId, ['EDIT_DETAILS', 'DELETE_TASKS']);

    const status = await patchTask(s.delegateToken, s.teamId, s.projectId, s.taskId, { status: 'IN_PROGRESS' });
    expect(status.statusCode).toBe(200);

    const title = await patchTask(s.delegateToken, s.teamId, s.projectId, s.taskId, { title: 'Nope' });
    expect(title.statusCode).toBe(403);

    const del = await app.inject({
      method: 'DELETE', url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}`, headers: H(s.delegateToken),
    });
    expect(del.statusCode).toBe(200);
  });

  it('a delegate can edit a manager-only date AND change responsible on the delegated project', async () => {
    const s = await setup();
    // Before delegation: no access at all → 404.
    const before = await patchTask(s.delegateToken, s.teamId, s.projectId, s.taskId, { dueDate: DUE_B });
    expect(before.statusCode).toBe(404);

    await putDelegates(s.ownerToken, s.teamId, s.projectId, [s.delegateId]);

    // After delegation: WRITE access + elevated past the manager-only date gate.
    const dateRes = await patchTask(s.delegateToken, s.teamId, s.projectId, s.taskId, { dueDate: DUE_B });
    expect(dateRes.statusCode).toBe(200);
    expect(dateRes.json().dueDate).toBe(DUE_B);

    // …and past the task.change_responsible gate (new responsible is a team member).
    const respRes = await patchTask(s.delegateToken, s.teamId, s.projectId, s.taskId, { responsibleId: s.otherId });
    expect(respRes.statusCode).toBe(200);
    expect(respRes.json().responsibleId).toBe(s.otherId);
  });

  it('SCOPE: a delegate on P is NOT elevated (nor granted access) on another project', async () => {
    const s = await setup();
    await putDelegates(s.ownerToken, s.teamId, s.projectId, [s.delegateId]);
    const res = await patchTask(s.delegateToken, s.teamId, s.project2Id, s.task2Id, { dueDate: DUE_B });
    expect(res.statusCode).toBe(404);
  });

  it('REVOCATION: removing the delegate drops the elevation (and access)', async () => {
    const s = await setup();
    await putDelegates(s.ownerToken, s.teamId, s.projectId, [s.delegateId]);
    expect((await patchTask(s.delegateToken, s.teamId, s.projectId, s.taskId, { dueDate: DUE_B })).statusCode).toBe(200);
    await putDelegates(s.ownerToken, s.teamId, s.projectId, []); // revoke all
    const res = await patchTask(s.delegateToken, s.teamId, s.projectId, s.taskId, { dueDate: DUE_A });
    expect(res.statusCode).toBe(404);
  });

  it('INTEGRITY: having project WRITE (as owner) does NOT by itself bypass the manager-only date gate', async () => {
    const s = await setup();
    // The owner has FULL access but team-role MEMBER and is not a delegate → the
    // manager-only date gate still applies. Proves delegation is a real, narrow
    // elevation, not "any write-holder bypasses".
    const res = await patchTask(s.ownerToken, s.teamId, s.projectId, s.taskId, { dueDate: DUE_B });
    expect(res.statusCode).toBe(403);
  });

  it('NEGATIVE: only owner/admin may manage delegates', async () => {
    const s = await setup();
    // A non-owner non-admin member is hidden the delegate surface (404).
    expect((await putDelegates(s.otherToken, s.teamId, s.projectId, [s.delegateId])).statusCode).toBe(404);
    // A global ADMIN can.
    expect((await putDelegates(s.adminToken, s.teamId, s.projectId, [s.delegateId])).statusCode).toBe(200);
    // A user from another team is rejected by the team gate (403).
    expect((await putDelegates(s.crossToken, s.teamId, s.projectId, [s.delegateId])).statusCode).toBe(403);
  });

  it('NEGATIVE: a delegate must be a team member (400)', async () => {
    const s = await setup();
    const res = await putDelegates(s.ownerToken, s.teamId, s.projectId, [s.outsiderId]);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/team/i);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';

// v2.5.58: whole-team project sharing (ProjectTeamShare) + plan freeze
// (Project.datesFrozen).
//   Shares: admin-managed replace-set PUT; FULL = WRITE, READONLY = READ for
//   every member of the guest team, through the HOME team's URLs; project
//   appears in the guest team's lists; guest members are assignable (FULL) and
//   see their tasks in /api/me/tasks. Unrelated teams stay locked out (404).
//   Freeze: plan dates 403 (PROJECT_DATES_FROZEN); reality capture stays open.

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

function putShares(
  token: string,
  teamId: string,
  projectId: string,
  shares: Array<{ teamId: string; level: 'FULL' | 'READONLY' }>,
) {
  return app.inject({
    method: 'PUT',
    url: `/api/teams/${teamId}/projects/${projectId}/team-shares`,
    headers: { authorization: `Bearer ${token}` },
    payload: { shares },
  });
}

function listProjectTasks(token: string, teamId: string, projectId: string) {
  return app.inject({
    method: 'GET',
    url: `/api/teams/${teamId}/projects/${projectId}/tasks`,
    headers: { authorization: `Bearer ${token}` },
  });
}

function createTask(token: string, teamId: string, projectId: string, payload: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: `/api/teams/${teamId}/projects/${projectId}/tasks`,
    headers: { authorization: `Bearer ${token}` },
    payload: { title: 'T', ...payload },
  });
}

function patchProject(token: string, teamId: string, projectId: string, payload: Record<string, unknown>) {
  return app.inject({
    method: 'PATCH',
    url: `/api/teams/${teamId}/projects/${projectId}`,
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}

const DAY = '2026-08-01T00:00:00.000Z';

describe('whole-team project shares (v2.5.58)', () => {
  it('FULL share: guest-team member reads and writes via home-team URLs; project appears in lists', async () => {
    const admin = await register('admin@x.com', 'ADMIN');
    const guest = await register('guest@x.com', 'MEMBER');
    const home = await createTeam(admin.token, 'home');
    const guestTeam = await createTeam(admin.token, 'guests');
    await addMember(admin.token, guestTeam, 'guest@x.com', 'MEMBER');
    const projectId = await createProject(admin.token, home, 'Shared P');

    // Before sharing: locked out (404 hides existence).
    expect((await listProjectTasks(guest.token, home, projectId)).statusCode).toBe(404);

    const put = await putShares(admin.token, home, projectId, [{ teamId: guestTeam, level: 'FULL' }]);
    expect(put.statusCode).toBe(200);
    expect(put.json()).toHaveLength(1);

    // Read + write through the HOME team URL.
    expect((await listProjectTasks(guest.token, home, projectId)).statusCode).toBe(200);
    const created = await createTask(guest.token, home, projectId, { title: 'from guest' });
    expect(created.statusCode).toBe(201);
    // Task keeps the HOME team's teamId (denormalization invariant).
    expect(created.json().teamId).toBe(home);

    // Cross-team list contains the shared project for the guest.
    const all = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { authorization: `Bearer ${guest.token}` },
    });
    expect(all.statusCode).toBe(200);
    expect(all.json().map((p: { id: string }) => p.id)).toContain(projectId);

    // Guest team's per-team list contains it too.
    const teamList = await app.inject({
      method: 'GET',
      url: `/api/teams/${guestTeam}/projects`,
      headers: { authorization: `Bearer ${guest.token}` },
    });
    expect(teamList.statusCode).toBe(200);
    expect(teamList.json().map((p: { id: string }) => p.id)).toContain(projectId);
  });

  it('READONLY share: guest reads but writes are 403; unrelated team stays 404', async () => {
    const admin = await register('admin@x.com', 'ADMIN');
    const guest = await register('guest@x.com', 'MEMBER');
    const stranger = await register('stranger@x.com', 'MEMBER');
    const home = await createTeam(admin.token, 'home');
    const guestTeam = await createTeam(admin.token, 'guests');
    const strangerTeam = await createTeam(admin.token, 'strangers');
    await addMember(admin.token, guestTeam, 'guest@x.com', 'MEMBER');
    await addMember(admin.token, strangerTeam, 'stranger@x.com', 'MEMBER');
    const projectId = await createProject(admin.token, home);

    await putShares(admin.token, home, projectId, [{ teamId: guestTeam, level: 'READONLY' }]);

    expect((await listProjectTasks(guest.token, home, projectId)).statusCode).toBe(200);
    expect((await createTask(guest.token, home, projectId)).statusCode).toBe(403);

    expect((await listProjectTasks(stranger.token, home, projectId)).statusCode).toBe(404);
    const strangerAll = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { authorization: `Bearer ${stranger.token}` },
    });
    expect(strangerAll.json().map((p: { id: string }) => p.id)).not.toContain(projectId);
  });

  it('share management is global-ADMIN only, and self-shares are rejected', async () => {
    const admin = await register('admin@x.com', 'ADMIN');
    const manager = await register('manager@x.com', 'MEMBER');
    const home = await createTeam(admin.token, 'home');
    const other = await createTeam(admin.token, 'other');
    await addMember(admin.token, home, 'manager@x.com', 'MANAGER');
    const projectId = await createProject(admin.token, home);

    const denied = await putShares(manager.token, home, projectId, [{ teamId: other, level: 'FULL' }]);
    expect(denied.statusCode).toBe(403);

    const selfShare = await putShares(admin.token, home, projectId, [{ teamId: home, level: 'FULL' }]);
    expect(selfShare.statusCode).toBe(400);
  });

  it('guest member of a FULL-shared team is assignable and sees the task in /api/me/tasks', async () => {
    const admin = await register('admin@x.com', 'ADMIN');
    const guest = await register('guest@x.com', 'MEMBER');
    const home = await createTeam(admin.token, 'home');
    const guestTeam = await createTeam(admin.token, 'guests');
    await addMember(admin.token, guestTeam, 'guest@x.com', 'MEMBER');
    const projectId = await createProject(admin.token, home);
    await putShares(admin.token, home, projectId, [{ teamId: guestTeam, level: 'FULL' }]);

    const created = await createTask(admin.token, home, projectId, { assigneeId: guest.userId });
    expect(created.statusCode).toBe(201);

    const mine = await app.inject({
      method: 'GET',
      url: '/api/me/tasks',
      headers: { authorization: `Bearer ${guest.token}` },
    });
    expect(mine.statusCode).toBe(200);
    const ids = mine.json().items.map((x: { id: string }) => x.id);
    expect(ids).toContain(created.json().id);
  });
});

describe('project plan freeze (v2.5.58)', () => {
  it('freezing blocks plan-date writes but not completion; unfreeze in the same PATCH lifts the gate', async () => {
    const admin = await register('admin@x.com', 'ADMIN');
    const teamId = await createTeam(admin.token, 'alpha');
    const projectId = await createProject(admin.token, teamId);
    const taskRes = await createTask(admin.token, teamId, projectId, { dueDate: DAY });
    const taskId = taskRes.json().id as string;

    const freeze = await patchProject(admin.token, teamId, projectId, { datesFrozen: true });
    expect(freeze.statusCode).toBe(200);
    expect(freeze.json().datesFrozen).toBe(true);

    // Plan-date writes are rejected with the stable code.
    const dateEdit = await app.inject({
      method: 'PATCH',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks/${taskId}`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { dueDate: '2026-09-01T00:00:00.000Z' },
    });
    expect(dateEdit.statusCode).toBe(403);
    expect(dateEdit.json().error.code).toBe('PROJECT_DATES_FROZEN');

    // New tasks: fine without dates, rejected with dates.
    expect((await createTask(admin.token, teamId, projectId, { title: 'undated' })).statusCode).toBe(201);
    const dated = await createTask(admin.token, teamId, projectId, { title: 'dated', dueDate: DAY });
    expect(dated.statusCode).toBe(403);

    // Project window edits are rejected too...
    const projDates = await patchProject(admin.token, teamId, projectId, { startDate: DAY });
    expect(projDates.statusCode).toBe(403);
    expect(projDates.json().error.code).toBe('PROJECT_DATES_FROZEN');

    // ...but completing a task (status change + completedAt auto-fill) works.
    const done = await app.inject({
      method: 'PATCH',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks/${taskId}`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { status: 'DONE', statusComment: 'wrapped up during freeze' },
    });
    expect(done.statusCode).toBe(200);
    expect(done.json().completedAt).toBeTruthy();

    // Unfreeze + date change in ONE request is allowed (unfreeze applies first).
    const unfreezeAndEdit = await patchProject(admin.token, teamId, projectId, {
      datesFrozen: false,
      startDate: DAY,
    });
    expect(unfreezeAndEdit.statusCode).toBe(200);
    expect(unfreezeAndEdit.json().datesFrozen).toBe(false);
  });

  it('only the owner or a global ADMIN may toggle the freeze', async () => {
    const admin = await register('admin@x.com', 'ADMIN');
    const owner = await register('owner@x.com', 'MEMBER');
    const manager = await register('manager@x.com', 'MEMBER');
    const teamId = await createTeam(admin.token, 'alpha');
    await addMember(admin.token, teamId, 'owner@x.com', 'MEMBER');
    await addMember(admin.token, teamId, 'manager@x.com', 'MANAGER');
    const projectId = await createProject(owner.token, teamId);

    // A non-owner manager is on the rename-only path → non-name fields 403.
    const denied = await patchProject(manager.token, teamId, projectId, { datesFrozen: true });
    expect(denied.statusCode).toBe(403);

    const ok = await patchProject(owner.token, teamId, projectId, { datesFrozen: true });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().datesFrozen).toBe(true);
  });
});

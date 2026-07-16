import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';

// v1.31: dashboard feeds — /reports/upcoming + /reports/activity. The
// upcoming endpoint is per-caller (assigneeId = req.user.sub); the activity
// endpoint is team-wide. Both gated by team membership + tasks:read.

let app: FastifyInstance;

beforeAll(async () => {
  process.env.MASTER_KEY ??=
    '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
  app = await buildApp(loadEnv());
});

afterAll(async () => {
  if (app) await app.close();
});

beforeEach(async () => {
  await prisma.refreshToken.deleteMany();
  await prisma.activity.deleteMany();
  await prisma.task.deleteMany();
  await prisma.project.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
});

const PASSWORD = 'CorrectHorseBattery9';
const DAY_MS = 24 * 60 * 60 * 1000;

async function register(email: string) {
  return bootstrapUser(app, { email, name: email.split('@')[0], password: PASSWORD });
}

async function createTeam(token: string, slug: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/teams',
    headers: { authorization: `Bearer ${token}` },
    payload: { name: slug, slug },
  });
  return res.json().id;
}

async function createProject(token: string, teamId: string, name = 'P'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/teams/${teamId}/projects`,
    headers: { authorization: `Bearer ${token}` },
    payload: { name },
  });
  return res.json().id;
}

async function addMember(
  managerToken: string,
  teamId: string,
  email: string,
  role: 'MEMBER' | 'MANAGER' = 'MEMBER',
) {
  await app.inject({
    method: 'POST',
    url: `/api/teams/${teamId}/members`,
    headers: { authorization: `Bearer ${managerToken}` },
    payload: { email, role },
  });
}

// Create a task with a specific dueDate / assignee. We go through the API
// (not raw prisma) so the activity-feed test below sees a real task.created
// event written by activityLogger.
async function createTask(
  token: string,
  teamId: string,
  projectId: string,
  opts: { title: string; assigneeId?: string; dueDate?: Date; status?: string },
): Promise<string> {
  const payload: Record<string, unknown> = { title: opts.title };
  if (opts.assigneeId) payload.assigneeId = opts.assigneeId;
  if (opts.dueDate) payload.dueDate = opts.dueDate.toISOString();
  const res = await app.inject({
    method: 'POST',
    url: `/api/teams/${teamId}/projects/${projectId}/tasks`,
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
  expect(res.statusCode).toBe(201);
  const id = res.json().id as string;
  if (opts.status && opts.status !== 'TODO') {
    await app.inject({
      method: 'PATCH',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks/${id}`,
      headers: { authorization: `Bearer ${token}` },
      // v2.5.58: transitions into DONE require a statusComment.
      payload:
        opts.status === 'DONE'
          ? { status: opts.status, statusComment: 'done (test)' }
          : { status: opts.status },
    });
  }
  return id;
}

function fetchUpcoming(token: string, teamId: string, qs = '') {
  return app.inject({
    method: 'GET',
    url: `/api/teams/${teamId}/reports/upcoming${qs ? `?${qs}` : ''}`,
    headers: { authorization: `Bearer ${token}` },
  });
}

function fetchActivity(token: string, teamId: string, qs = '') {
  return app.inject({
    method: 'GET',
    url: `/api/teams/${teamId}/reports/activity${qs ? `?${qs}` : ''}`,
    headers: { authorization: `Bearer ${token}` },
  });
}

describe('GET /api/teams/:teamId/reports/upcoming', () => {
  it('returns the calling users tasks due in the next N days, sorted by dueDate asc', async () => {
    const me = await register('me@example.com');
    const teamId = await createTeam(me.token, 'team-a');
    const projectId = await createProject(me.token, teamId);

    const now = Date.now();
    await createTask(me.token, teamId, projectId, {
      title: 'in 5 days',
      assigneeId: me.userId,
      dueDate: new Date(now + 5 * DAY_MS),
    });
    await createTask(me.token, teamId, projectId, {
      title: 'in 1 day',
      assigneeId: me.userId,
      dueDate: new Date(now + 1 * DAY_MS),
    });

    const res = await fetchUpcoming(me.token, teamId);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.windowDays).toBe(7);
    const titles = body.items.map((i: { taskTitle: string }) => i.taskTitle);
    expect(titles).toEqual(['in 1 day', 'in 5 days']);
    expect(body.items[0].daysUntil).toBeGreaterThanOrEqual(0);
    expect(body.items[0].daysUntil).toBeLessThanOrEqual(1);
    expect(body.items[0].projectName).toBe('P');
    expect(body.items[0].priority).toBe('MEDIUM');
  });

  it('excludes tasks outside the lookback window', async () => {
    const me = await register('me@example.com');
    const teamId = await createTeam(me.token, 'team-a');
    const projectId = await createProject(me.token, teamId);
    await createTask(me.token, teamId, projectId, {
      title: 'in 30 days',
      assigneeId: me.userId,
      dueDate: new Date(Date.now() + 30 * DAY_MS),
    });
    const res = await fetchUpcoming(me.token, teamId);
    expect(res.json().items).toEqual([]);
  });

  it('respects ?days= up to the cap of 30', async () => {
    const me = await register('me@example.com');
    const teamId = await createTeam(me.token, 'team-a');
    const projectId = await createProject(me.token, teamId);
    await createTask(me.token, teamId, projectId, {
      title: 'in 14 days',
      assigneeId: me.userId,
      dueDate: new Date(Date.now() + 14 * DAY_MS),
    });

    // Default 7 days — task not visible.
    const seven = await fetchUpcoming(me.token, teamId);
    expect(seven.json().items).toEqual([]);

    // 30 days — task visible.
    const thirty = await fetchUpcoming(me.token, teamId, 'days=30');
    expect(thirty.json().items.map((i: { taskTitle: string }) => i.taskTitle)).toEqual([
      'in 14 days',
    ]);
    expect(thirty.json().windowDays).toBe(30);

    // Over the cap — schema rejects with 400.
    const overCap = await fetchUpcoming(me.token, teamId, 'days=365');
    expect(overCap.statusCode).toBe(400);
  });

  it('excludes DONE tasks even if dueDate falls inside the window', async () => {
    const me = await register('me@example.com');
    const teamId = await createTeam(me.token, 'team-a');
    const projectId = await createProject(me.token, teamId);
    await createTask(me.token, teamId, projectId, {
      title: 'finished',
      assigneeId: me.userId,
      dueDate: new Date(Date.now() + 2 * DAY_MS),
      status: 'DONE',
    });
    const res = await fetchUpcoming(me.token, teamId);
    expect(res.json().items).toEqual([]);
  });

  it('excludes soft-deleted tasks', async () => {
    const me = await register('me@example.com');
    const teamId = await createTeam(me.token, 'team-a');
    const projectId = await createProject(me.token, teamId);
    const id = await createTask(me.token, teamId, projectId, {
      title: 'trashed',
      assigneeId: me.userId,
      dueDate: new Date(Date.now() + 2 * DAY_MS),
    });
    await prisma.task.update({ where: { id }, data: { deletedAt: new Date() } });
    const res = await fetchUpcoming(me.token, teamId);
    expect(res.json().items).toEqual([]);
  });

  it("does NOT return another user's tasks even within the same team", async () => {
    const owner = await register('owner@example.com');
    const teamId = await createTeam(owner.token, 'team-a');
    const projectId = await createProject(owner.token, teamId);

    const mate = await register('mate@example.com');
    await addMember(owner.token, teamId, mate.email);

    await createTask(owner.token, teamId, projectId, {
      title: "owner's task",
      assigneeId: owner.userId,
      dueDate: new Date(Date.now() + 2 * DAY_MS),
    });

    const res = await fetchUpcoming(mate.token, teamId);
    expect(res.json().items).toEqual([]);
  });

  it('rejects non-members with 403', async () => {
    const owner = await register('owner@example.com');
    const teamId = await createTeam(owner.token, 'team-a');

    const stranger = await register('stranger@example.com');
    const res = await fetchUpcoming(stranger.token, teamId);
    expect(res.statusCode).toBe(403);
  });
});

describe('GET /api/teams/:teamId/reports/activity', () => {
  it('returns team-scoped activity newest-first with actor + task + project joined', async () => {
    const me = await register('me@example.com');
    const teamId = await createTeam(me.token, 'team-a');
    const projectId = await createProject(me.token, teamId, 'Phoenix');
    await createTask(me.token, teamId, projectId, { title: 'do thing' });

    const res = await fetchActivity(me.token, teamId);
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<{
      action: string;
      actorName: string;
      taskTitle: string | null;
      projectName: string | null;
    }>;
    const created = items.find((i) => i.action === 'task.created');
    expect(created).toBeTruthy();
    expect(created!.actorName).toBe('me');
    expect(created!.taskTitle).toBe('do thing');
    expect(created!.projectName).toBe('Phoenix');
  });

  it('respects ?limit= (cap 100, default 20)', async () => {
    const me = await register('me@example.com');
    const teamId = await createTeam(me.token, 'team-a');
    const projectId = await createProject(me.token, teamId);
    for (let i = 0; i < 5; i++) {
      await createTask(me.token, teamId, projectId, { title: `t${i}` });
    }
    const limited = await fetchActivity(me.token, teamId, 'limit=3');
    expect(limited.json().items).toHaveLength(3);

    const overCap = await fetchActivity(me.token, teamId, 'limit=999');
    expect(overCap.statusCode).toBe(400);
  });

  it('cross-team isolation: activity from team B is not visible to team A members', async () => {
    const me = await register('me@example.com');
    const teamA = await createTeam(me.token, 'team-a');
    const projA = await createProject(me.token, teamA);
    await createTask(me.token, teamA, projA, { title: 'a-task' });

    const other = await register('other@example.com');
    const teamB = await createTeam(other.token, 'team-b');
    const projB = await createProject(other.token, teamB);
    await createTask(other.token, teamB, projB, { title: 'b-task' });

    const res = await fetchActivity(me.token, teamA);
    const titles = (res.json().items as Array<{ taskTitle: string | null }>)
      .map((i) => i.taskTitle)
      .filter((t): t is string => t !== null);
    expect(titles).toContain('a-task');
    expect(titles).not.toContain('b-task');
  });

  it('rejects non-members with 403', async () => {
    const owner = await register('owner@example.com');
    const teamId = await createTeam(owner.token, 'team-a');
    const stranger = await register('stranger@example.com');
    const res = await fetchActivity(stranger.token, teamId);
    expect(res.statusCode).toBe(403);
  });

  it('falls back to "(deleted user)" when the actor was unlinked', async () => {
    const owner = await register('owner@example.com');
    const teamId = await createTeam(owner.token, 'team-a');
    const projectId = await createProject(owner.token, teamId);
    await createTask(owner.token, teamId, projectId, { title: 'x' });
    // Null the actor on every Activity row in this team — simulates a
    // SetNull cascade after the actor was hard-deleted.
    await prisma.activity.updateMany({ where: { teamId }, data: { actorId: null } });

    const res = await fetchActivity(owner.token, teamId);
    const item = (res.json().items as Array<{ actorName: string; actorId: string | null }>)[0];
    expect(item?.actorId).toBeNull();
    expect(item?.actorName).toBe('(system)');
  });
});

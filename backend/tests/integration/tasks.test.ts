import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';

let app: FastifyInstance;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_ACCESS_SECRET ||= 'test_access_secret_at_least_32_chars_long_xx';
  process.env.JWT_REFRESH_SECRET ||= 'test_refresh_secret_at_least_32_chars_long_x';
  process.env.CORS_ORIGINS ||= 'http://localhost:5173';
  process.env.COOKIE_SECURE ||= 'false';
  const env = loadEnv();
  app = await buildApp(env);
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await prisma.refreshToken.deleteMany();
  await prisma.passwordReset.deleteMany();
  await prisma.task.deleteMany();
  await prisma.project.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
});

async function inject(opts: Parameters<FastifyInstance['inject']>[0]) {
  return app.inject(opts);
}

const PASSWORD = 'CorrectHorseBattery9';

async function registerUser(email: string): Promise<{ token: string; userId: string }> {
  const r = await bootstrapUser(app, { email, name: email.split('@')[0], password: PASSWORD });
  return { token: r.token, userId: r.userId };
}

async function createTeam(token: string, slug = 'team-a') {
  const res = await inject({
    method: 'POST',
    url: '/api/teams',
    headers: { authorization: `Bearer ${token}` },
    payload: { name: 'Team A', slug },
  });
  if (res.statusCode !== 201) throw new Error(`createTeam failed: ${res.statusCode}`);
  return res.json();
}

async function createProject(token: string, teamId: string, name = 'P1') {
  const res = await inject({
    method: 'POST',
    url: `/api/teams/${teamId}/projects`,
    headers: { authorization: `Bearer ${token}` },
    payload: { name },
  });
  if (res.statusCode !== 201) throw new Error(`createProject failed: ${res.statusCode}`);
  return res.json();
}

async function addMember(managerToken: string, teamId: string, email: string, role: 'MEMBER' | 'MANAGER' = 'MEMBER') {
  const res = await inject({
    method: 'POST',
    url: `/api/teams/${teamId}/members`,
    headers: { authorization: `Bearer ${managerToken}` },
    payload: { email, role },
  });
  if (res.statusCode !== 201) throw new Error(`addMember failed: ${res.statusCode}`);
  return res.json();
}

describe('POST /api/teams/:teamId/projects/:projectId/tasks', () => {
  it('creates a task with defaults', async () => {
    const { token } = await registerUser('a@example.com');
    const team = await createTeam(token, 'acme');
    const project = await createProject(token, team.id);
    const res = await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'Write docs' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.title).toBe('Write docs');
    expect(body.status).toBe('TODO');
    expect(body.priority).toBe('MEDIUM');
    expect(body.teamId).toBe(team.id);
    expect(body.projectId).toBe(project.id);
    expect(body.position).toBeGreaterThan(0);
  });

  it('assigns sparse positions appending to a column', async () => {
    const { token } = await registerUser('a@example.com');
    const team = await createTeam(token, 'acme');
    const project = await createProject(token, team.id);
    const first = await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'A' },
    });
    const second = await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'B' },
    });
    expect(second.json().position).toBeGreaterThan(first.json().position);
  });

  it('rejects non-members with 403', async () => {
    const { token: tokenA } = await registerUser('a@example.com');
    const { token: tokenB } = await registerUser('b@example.com');
    const team = await createTeam(tokenA, 'acme');
    const project = await createProject(tokenA, team.id);
    const res = await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks`,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { title: 'Spy task' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects assigning to a non-team-member', async () => {
    const { token } = await registerUser('a@example.com');
    const { userId: outsiderId } = await registerUser('outsider@example.com');
    const team = await createTeam(token, 'acme');
    const project = await createProject(token, team.id);
    const res = await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'Bad assignment', assigneeId: outsiderId },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when projectId belongs to a different team', async () => {
    const { token: tokenA } = await registerUser('a@example.com');
    const { token: tokenB } = await registerUser('b@example.com');
    const teamA = await createTeam(tokenA, 'acme');
    const teamB = await createTeam(tokenB, 'beta');
    const projectB = await createProject(tokenB, teamB.id);
    // A is a member of teamA but not teamB. Probing teamA's URL with teamB's project id.
    const res = await inject({
      method: 'POST',
      url: `/api/teams/${teamA.id}/projects/${projectB.id}/tasks`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { title: 'Spy task' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/teams/:teamId/projects/:projectId/tasks', () => {
  it('filters by status', async () => {
    const { token } = await registerUser('a@example.com');
    const team = await createTeam(token, 'acme');
    const project = await createProject(token, team.id);
    await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'In TODO' },
    });
    await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'In DONE', status: 'DONE' },
    });

    const all = await inject({
      method: 'GET',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(all.json()).toHaveLength(2);

    const onlyDone = await inject({
      method: 'GET',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks?status=DONE`,
      headers: { authorization: `Bearer ${token}` },
    });
    const items = onlyDone.json();
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('In DONE');
  });
});

describe('task startDate field (v1.37)', () => {
  it('accepts startDate on create + surfaces it in the response', async () => {
    const r = await registerUser('me@example.com');
    const team = await createTeam(r.token);
    const project = await createProject(r.token, team.id);

    const startIso = '2026-05-15T00:00:00.000Z';
    const res = await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks`,
      headers: { authorization: `Bearer ${r.token}` },
      payload: { title: 'with start', startDate: startIso },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.startDate).toBe(startIso);
  });

  it('defaults startDate to null when omitted on create', async () => {
    const r = await registerUser('me@example.com');
    const team = await createTeam(r.token);
    const project = await createProject(r.token, team.id);
    const res = await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks`,
      headers: { authorization: `Bearer ${r.token}` },
      payload: { title: 'no start' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().startDate).toBeNull();
  });

  it('PATCH sets startDate and PATCH null clears it', async () => {
    const r = await registerUser('me@example.com');
    const team = await createTeam(r.token);
    const project = await createProject(r.token, team.id);
    const created = (
      await inject({
        method: 'POST',
        url: `/api/teams/${team.id}/projects/${project.id}/tasks`,
        headers: { authorization: `Bearer ${r.token}` },
        payload: { title: 't' },
      })
    ).json();

    const setIso = '2026-06-01T00:00:00.000Z';
    const setRes = await inject({
      method: 'PATCH',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks/${created.id}`,
      headers: { authorization: `Bearer ${r.token}` },
      payload: { startDate: setIso },
    });
    expect(setRes.statusCode).toBe(200);
    expect(setRes.json().startDate).toBe(setIso);

    const clear = await inject({
      method: 'PATCH',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks/${created.id}`,
      headers: { authorization: `Bearer ${r.token}` },
      payload: { startDate: null },
    });
    expect(clear.statusCode).toBe(200);
    expect(clear.json().startDate).toBeNull();
  });
});

describe('task completedAt field', () => {
  it('is null for a new TODO task', async () => {
    const { token } = await registerUser('a@example.com');
    const team = await createTeam(token, 'acme');
    const project = await createProject(token, team.id);
    const res = await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'fresh' },
    });
    expect(res.json().completedAt).toBeNull();
  });

  it('auto-fills completedAt when a task is created directly in DONE', async () => {
    const { token } = await registerUser('a@example.com');
    const team = await createTeam(token, 'acme');
    const project = await createProject(token, team.id);
    const res = await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'born done', status: 'DONE' },
    });
    expect(res.json().completedAt).toBeTypeOf('string');
  });

  it('auto-fills completedAt when status transitions to DONE and completedAt was null', async () => {
    const { token } = await registerUser('a@example.com');
    const team = await createTeam(token, 'acme');
    const project = await createProject(token, team.id);
    const task = (
      await inject({
        method: 'POST',
        url: `/api/teams/${team.id}/projects/${project.id}/tasks`,
        headers: { authorization: `Bearer ${token}` },
        payload: { title: 'will finish' },
      })
    ).json();
    expect(task.completedAt).toBeNull();
    const moved = await inject({
      method: 'PATCH',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks/${task.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { status: 'DONE' },
    });
    expect(moved.json().completedAt).toBeTypeOf('string');
  });

  it('accepts an explicit backdated completedAt and overrides the auto-fill', async () => {
    const { token } = await registerUser('a@example.com');
    const team = await createTeam(token, 'acme');
    const project = await createProject(token, team.id);
    const task = (
      await inject({
        method: 'POST',
        url: `/api/teams/${team.id}/projects/${project.id}/tasks`,
        headers: { authorization: `Bearer ${token}` },
        payload: { title: 'backdated' },
      })
    ).json();
    const backdate = '2026-01-15T10:00:00.000Z';
    const res = await inject({
      method: 'PATCH',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks/${task.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { status: 'DONE', completedAt: backdate },
    });
    expect(res.json().completedAt).toBe(backdate);
  });

  it('preserves a previously set completedAt when status changes to DONE again', async () => {
    const { token } = await registerUser('a@example.com');
    const team = await createTeam(token, 'acme');
    const project = await createProject(token, team.id);
    const backdate = '2026-02-01T08:00:00.000Z';
    const task = (
      await inject({
        method: 'POST',
        url: `/api/teams/${team.id}/projects/${project.id}/tasks`,
        headers: { authorization: `Bearer ${token}` },
        payload: { title: 'with completedAt', completedAt: backdate },
      })
    ).json();
    expect(task.completedAt).toBe(backdate);
    // Move it through statuses and back to DONE — original completedAt should survive.
    await inject({
      method: 'PATCH',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks/${task.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { status: 'IN_PROGRESS' },
    });
    const back = await inject({
      method: 'PATCH',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks/${task.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { status: 'DONE' },
    });
    // completedAt was non-null prior to this transition, so the auto-fill is skipped.
    expect(back.json().completedAt).toBe(backdate);
  });

  it('allows clearing completedAt with null', async () => {
    const { token } = await registerUser('a@example.com');
    const team = await createTeam(token, 'acme');
    const project = await createProject(token, team.id);
    const task = (
      await inject({
        method: 'POST',
        url: `/api/teams/${team.id}/projects/${project.id}/tasks`,
        headers: { authorization: `Bearer ${token}` },
        payload: { title: 'cleared', status: 'DONE' },
      })
    ).json();
    expect(task.completedAt).toBeTypeOf('string');
    const cleared = await inject({
      method: 'PATCH',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks/${task.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { completedAt: null },
    });
    expect(cleared.json().completedAt).toBeNull();
  });
});

describe('PATCH /api/teams/:teamId/projects/:projectId/tasks/:taskId', () => {
  it('moving across columns puts the task at the end of the new column', async () => {
    const { token } = await registerUser('a@example.com');
    const team = await createTeam(token, 'acme');
    const project = await createProject(token, team.id);

    // Create one DONE task to establish a non-empty target column.
    const seedDone = await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'Already done', status: 'DONE' },
    });
    const doneSeedPos = seedDone.json().position;

    // Now create a TODO task and move it to DONE.
    const todoTask = (
      await inject({
        method: 'POST',
        url: `/api/teams/${team.id}/projects/${project.id}/tasks`,
        headers: { authorization: `Bearer ${token}` },
        payload: { title: 'Moving' },
      })
    ).json();

    const moved = await inject({
      method: 'PATCH',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks/${todoTask.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { status: 'DONE' },
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().status).toBe('DONE');
    expect(moved.json().position).toBeGreaterThan(doneSeedPos);
  });
});

describe('DELETE /api/teams/:teamId/projects/:projectId/tasks/:taskId', () => {
  it('any team member can delete; 404 once gone', async () => {
    const { token } = await registerUser('a@example.com');
    await registerUser('b@example.com');
    const team = await createTeam(token, 'acme');
    await addMember(token, team.id, 'b@example.com');
    const project = await createProject(token, team.id);
    const task = (
      await inject({
        method: 'POST',
        url: `/api/teams/${team.id}/projects/${project.id}/tasks`,
        headers: { authorization: `Bearer ${token}` },
        payload: { title: 'temp' },
      })
    ).json();

    // Delete as a MEMBER, not the creator — both should work.
    const memberLogin = await inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'b@example.com', password: PASSWORD },
    });
    const memberToken = memberLogin.json().accessToken;

    const del = await inject({
      method: 'DELETE',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks/${task.id}`,
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(del.statusCode).toBe(204);

    const again = await inject({
      method: 'DELETE',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks/${task.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(again.statusCode).toBe(404);
  });
});

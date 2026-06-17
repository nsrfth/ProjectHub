import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';

// v1.80: global "predefined" labels — admin-managed (teamId NULL), visible and
// usable in every team alongside that team's own user-defined labels.

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
  await prisma.label.deleteMany(); // includes globals (teamId NULL)
  await prisma.teamMembership.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
});

const PASSWORD = 'CorrectHorseBattery9';
const COLOR = '#3b82f6';

async function register(email: string, globalRole: 'ADMIN' | 'MEMBER') {
  const r = await bootstrapUser(app, { email, name: email.split('@')[0], password: PASSWORD, globalRole });
  return { token: r.token, userId: r.userId };
}
function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}
async function createTeam(token: string, slug: string): Promise<{ id: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/teams', headers: auth(token), payload: { name: slug, slug } });
  if (res.statusCode !== 201) throw new Error(`createTeam ${res.statusCode} ${res.body}`);
  return res.json() as { id: string };
}
async function createGlobal(adminToken: string, name: string) {
  return app.inject({ method: 'POST', url: '/api/admin/labels', headers: auth(adminToken), payload: { name, color: COLOR } });
}
async function listTeamLabels(token: string, teamId: string) {
  const res = await app.inject({ method: 'GET', url: `/api/teams/${teamId}/labels`, headers: auth(token) });
  return res.json() as Array<{ id: string; name: string; teamId: string | null; isPredefined: boolean }>;
}
async function createProject(token: string, teamId: string): Promise<{ id: string }> {
  const res = await app.inject({ method: 'POST', url: `/api/teams/${teamId}/projects`, headers: auth(token), payload: { name: 'P' } });
  if (res.statusCode !== 201) throw new Error(`createProject ${res.statusCode} ${res.body}`);
  return res.json() as { id: string };
}

describe('global predefined labels', () => {
  it('admin creates a global label; it appears in every team with isPredefined=true', async () => {
    const admin = await register('admin@x.com', 'ADMIN');
    const g = await createGlobal(admin.token, 'Urgent');
    expect(g.statusCode).toBe(201);
    const gl = g.json() as { id: string; teamId: string | null; isPredefined: boolean };
    expect(gl.teamId).toBeNull();
    expect(gl.isPredefined).toBe(true);

    const teamA = await createTeam(admin.token, 'team-a');
    const teamB = await createTeam(admin.token, 'team-b');
    for (const teamId of [teamA.id, teamB.id]) {
      const labels = await listTeamLabels(admin.token, teamId);
      const found = labels.find((l) => l.id === gl.id);
      expect(found).toBeTruthy();
      expect(found!.isPredefined).toBe(true);
    }
  });

  it('a non-admin cannot manage global labels (403)', async () => {
    await register('admin@x.com', 'ADMIN'); // ensure not first-user-auto-admin
    const member = await register('member@x.com', 'MEMBER');
    const res = await createGlobal(member.token, 'Nope');
    expect(res.statusCode).toBe(403);
  });

  it('lets a task be created with a global label id (not rejected as cross-team)', async () => {
    const admin = await register('admin@x.com', 'ADMIN');
    const g = (await createGlobal(admin.token, 'Blocked')).json() as { id: string };
    const team = await createTeam(admin.token, 'team-a');
    const project = await createProject(admin.token, team.id);
    const res = await app.inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks`,
      headers: auth(admin.token),
      payload: { title: 'T', labelIds: [g.id] },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { labels: Array<{ id: string }> };
    expect(body.labels.map((l) => l.id)).toContain(g.id);
  });

  it('lets a global label be attached to an existing task', async () => {
    const admin = await register('admin@x.com', 'ADMIN');
    const g = (await createGlobal(admin.token, 'Review')).json() as { id: string };
    const team = await createTeam(admin.token, 'team-a');
    const project = await createProject(admin.token, team.id);
    const task = (await app.inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks`,
      headers: auth(admin.token),
      payload: { title: 'T' },
    })).json() as { id: string };

    const res = await app.inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks/${task.id}/labels`,
      headers: auth(admin.token),
      payload: { labelId: g.id },
    });
    expect(res.statusCode).toBe(201);
  });

  it('does not let a team endpoint edit/delete a global label (404)', async () => {
    const admin = await register('admin@x.com', 'ADMIN');
    const g = (await createGlobal(admin.token, 'Locked')).json() as { id: string };
    const team = await createTeam(admin.token, 'team-a');

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/teams/${team.id}/labels/${g.id}`,
      headers: auth(admin.token),
      payload: { name: 'Hacked' },
    });
    expect(patch.statusCode).toBe(404);

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/teams/${team.id}/labels/${g.id}`,
      headers: auth(admin.token),
    });
    expect(del.statusCode).toBe(404);
  });

  it('enforces global-name uniqueness but allows a team label to reuse a global name', async () => {
    const admin = await register('admin@x.com', 'ADMIN');
    expect((await createGlobal(admin.token, 'Bug')).statusCode).toBe(201);
    expect((await createGlobal(admin.token, 'Bug')).statusCode).toBe(409); // duplicate global

    const team = await createTeam(admin.token, 'team-a');
    const teamLabel = await app.inject({
      method: 'POST',
      url: `/api/teams/${team.id}/labels`,
      headers: auth(admin.token),
      payload: { name: 'Bug', color: COLOR }, // same name as a global — allowed
    });
    expect(teamLabel.statusCode).toBe(201);
    expect((teamLabel.json() as { isPredefined: boolean }).isPredefined).toBe(false);
  });

  it('keeps team labels team-scoped (not visible to other teams)', async () => {
    const admin = await register('admin@x.com', 'ADMIN');
    const teamA = await createTeam(admin.token, 'team-a');
    const teamB = await createTeam(admin.token, 'team-b');
    await app.inject({
      method: 'POST',
      url: `/api/teams/${teamA.id}/labels`,
      headers: auth(admin.token),
      payload: { name: 'OnlyA', color: COLOR },
    });
    const bLabels = await listTeamLabels(admin.token, teamB.id);
    expect(bLabels.find((l) => l.name === 'OnlyA')).toBeUndefined();
  });
});

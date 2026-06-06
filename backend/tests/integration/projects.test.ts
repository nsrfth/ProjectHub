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
  await prisma.project.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
});

async function inject(opts: Parameters<FastifyInstance['inject']>[0]) {
  return app.inject(opts);
}

const PASSWORD = 'CorrectHorseBattery9';

async function registerUser(email: string, name = 'User'): Promise<string> {
  const r = await bootstrapUser(app, { email, name, password: PASSWORD });
  return r.token;
}

async function createTeam(token: string, slug = 'team-a', name = 'Team A') {
  const res = await inject({
    method: 'POST',
    url: '/api/teams',
    headers: { authorization: `Bearer ${token}` },
    payload: { name, slug },
  });
  if (res.statusCode !== 201) throw new Error(`createTeam failed: ${res.statusCode}`);
  return res.json();
}

async function addMember(managerToken: string, teamId: string, email: string, role: 'MEMBER' | 'MANAGER') {
  const res = await inject({
    method: 'POST',
    url: `/api/teams/${teamId}/members`,
    headers: { authorization: `Bearer ${managerToken}` },
    payload: { email, role },
  });
  if (res.statusCode !== 201) throw new Error(`addMember failed: ${res.statusCode}`);
  return res.json();
}

describe('POST /api/teams/:teamId/projects', () => {
  it('creates a project owned by the caller', async () => {
    const token = await registerUser('a@example.com');
    const team = await createTeam(token, 'acme');
    const res = await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Mobile App', description: 'iOS first' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.name).toBe('Mobile App');
    expect(body.teamId).toBe(team.id);
    expect(body.status).toBe('ACTIVE');
  });

  it('rejects non-members with 403', async () => {
    const tokenA = await registerUser('a@example.com');
    const tokenB = await registerUser('b@example.com');
    const team = await createTeam(tokenA, 'acme');
    const res = await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects`,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { name: 'Spy Project' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects unauthenticated callers with 401', async () => {
    const token = await registerUser('a@example.com');
    const team = await createTeam(token, 'acme');
    const res = await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects`,
      payload: { name: 'Mobile App' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /api/teams/:teamId/projects', () => {
  it('lists only that teams projects (multi-tenancy)', async () => {
    const tokenA = await registerUser('a@example.com');
    const tokenB = await registerUser('b@example.com');
    const teamA = await createTeam(tokenA, 'acme');
    const teamB = await createTeam(tokenB, 'beta');

    await inject({
      method: 'POST',
      url: `/api/teams/${teamA.id}/projects`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { name: 'A1' },
    });
    await inject({
      method: 'POST',
      url: `/api/teams/${teamB.id}/projects`,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { name: 'B1' },
    });

    const res = await inject({
      method: 'GET',
      url: `/api/teams/${teamA.id}/projects`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('A1');
  });
});

describe('GET /api/teams/:teamId/projects/:projectId', () => {
  it('returns 404 (not 200) when project belongs to a different team', async () => {
    const tokenA = await registerUser('a@example.com');
    const tokenB = await registerUser('b@example.com');
    const teamA = await createTeam(tokenA, 'acme');
    const teamB = await createTeam(tokenB, 'beta');
    // B creates a project in team B, then A tries to fetch it via team A's URL.
    const projB = (
      await inject({
        method: 'POST',
        url: `/api/teams/${teamB.id}/projects`,
        headers: { authorization: `Bearer ${tokenB}` },
        payload: { name: 'B-only' },
      })
    ).json();

    const res = await inject({
      method: 'GET',
      url: `/api/teams/${teamA.id}/projects/${projB.id}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    // The route requireTeamRole passes (A is a member of teamA), but the
    // service guard catches the cross-tenant id and returns 404 — never leak
    // existence of another team's resources.
    expect(res.statusCode).toBe(404);
  });
});

describe('PATCH /api/teams/:teamId/projects/:projectId', () => {
  it('allows the owner to update their own project', async () => {
    const token = await registerUser('a@example.com');
    const team = await createTeam(token, 'acme');
    const proj = (
      await inject({
        method: 'POST',
        url: `/api/teams/${team.id}/projects`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Old' },
      })
    ).json();

    const res = await inject({
      method: 'PATCH',
      url: `/api/teams/${team.id}/projects/${proj.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'New', status: 'ARCHIVED' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('New');
    expect(res.json().status).toBe('ARCHIVED');
  });

  it('forbids a MEMBER from editing someone elses project', async () => {
    const tokenOwner = await registerUser('owner@example.com');
    const tokenMember = await registerUser('member@example.com');
    const team = await createTeam(tokenOwner, 'acme');
    await addMember(tokenOwner, team.id, 'member@example.com', 'MEMBER');

    const proj = (
      await inject({
        method: 'POST',
        url: `/api/teams/${team.id}/projects`,
        headers: { authorization: `Bearer ${tokenOwner}` },
        payload: { name: 'OwnerProj' },
      })
    ).json();

    const res = await inject({
      method: 'PATCH',
      url: `/api/teams/${team.id}/projects/${proj.id}`,
      headers: { authorization: `Bearer ${tokenMember}` },
      payload: { name: 'Hijacked' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('allows a team MANAGER to edit any project in their team', async () => {
    const tokenManager = await registerUser('mgr@example.com');
    const tokenOwner = await registerUser('owner@example.com');
    const team = await createTeam(tokenManager, 'acme');
    await addMember(tokenManager, team.id, 'owner@example.com', 'MEMBER');

    const proj = (
      await inject({
        method: 'POST',
        url: `/api/teams/${team.id}/projects`,
        headers: { authorization: `Bearer ${tokenOwner}` },
        payload: { name: 'MemberProj' },
      })
    ).json();

    const res = await inject({
      method: 'PATCH',
      url: `/api/teams/${team.id}/projects/${proj.id}`,
      headers: { authorization: `Bearer ${tokenManager}` },
      payload: { status: 'ON_HOLD' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ON_HOLD');
  });
});

describe('DELETE /api/teams/:teamId/projects/:projectId', () => {
  it('forbids non-owner non-manager from deleting', async () => {
    const tokenOwner = await registerUser('owner@example.com');
    const tokenMember = await registerUser('member@example.com');
    const team = await createTeam(tokenOwner, 'acme');
    await addMember(tokenOwner, team.id, 'member@example.com', 'MEMBER');

    const proj = (
      await inject({
        method: 'POST',
        url: `/api/teams/${team.id}/projects`,
        headers: { authorization: `Bearer ${tokenOwner}` },
        payload: { name: 'OwnerProj' },
      })
    ).json();

    const res = await inject({
      method: 'DELETE',
      url: `/api/teams/${team.id}/projects/${proj.id}`,
      headers: { authorization: `Bearer ${tokenMember}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('allows the owner to delete', async () => {
    const token = await registerUser('a@example.com');
    const team = await createTeam(token, 'acme');
    const proj = (
      await inject({
        method: 'POST',
        url: `/api/teams/${team.id}/projects`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'OwnerProj' },
      })
    ).json();

    const res = await inject({
      method: 'DELETE',
      url: `/api/teams/${team.id}/projects/${proj.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(204);
  });
});

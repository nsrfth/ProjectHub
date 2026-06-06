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
  // Order matters: rows that reference users/teams via FK must go first.
  await prisma.refreshToken.deleteMany();
  await prisma.passwordReset.deleteMany();
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
  if (res.statusCode !== 201) throw new Error(`createTeam failed: ${res.statusCode} ${res.body}`);
  return res.json();
}

describe('POST /api/teams', () => {
  it('creates a team and makes the caller MANAGER', async () => {
    const token = await registerUser('a@example.com');
    const res = await inject({
      method: 'POST',
      url: '/api/teams',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Acme', slug: 'acme' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.name).toBe('Acme');
    expect(body.slug).toBe('acme');
    expect(body.myRole).toBe('MANAGER');
  });

  it('rejects unauthenticated requests', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/teams',
      payload: { name: 'Acme', slug: 'acme' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 409 on duplicate slug', async () => {
    const token = await registerUser('a@example.com');
    await createTeam(token, 'acme');
    const dup = await inject({
      method: 'POST',
      url: '/api/teams',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Acme 2', slug: 'acme' },
    });
    expect(dup.statusCode).toBe(409);
  });

  it('rejects malformed slug', async () => {
    const token = await registerUser('a@example.com');
    const res = await inject({
      method: 'POST',
      url: '/api/teams',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Acme', slug: 'Bad Slug!' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/teams', () => {
  it('returns only teams the caller belongs to', async () => {
    const tokenA = await registerUser('a@example.com');
    const tokenB = await registerUser('b@example.com');
    await createTeam(tokenA, 'acme');
    await createTeam(tokenB, 'beta');

    const res = await inject({
      method: 'GET',
      url: '/api/teams',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    const teams = res.json();
    expect(teams).toHaveLength(1);
    expect(teams[0].slug).toBe('acme');
  });
});

describe('GET /api/teams/:teamId', () => {
  it('returns detail with member list for a member', async () => {
    const token = await registerUser('a@example.com', 'Alice');
    const team = await createTeam(token, 'acme');
    const res = await inject({
      method: 'GET',
      url: `/api/teams/${team.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.members).toHaveLength(1);
    expect(body.members[0].email).toBe('a@example.com');
    expect(body.members[0].role).toBe('MANAGER');
  });

  it('returns 403 to a non-member', async () => {
    const tokenA = await registerUser('a@example.com');
    const tokenB = await registerUser('b@example.com');
    const team = await createTeam(tokenA, 'acme');
    const res = await inject({
      method: 'GET',
      url: `/api/teams/${team.id}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('team membership', () => {
  it('MANAGER can add an existing user as MEMBER', async () => {
    const tokenA = await registerUser('a@example.com');
    await registerUser('b@example.com', 'Bob');
    const team = await createTeam(tokenA, 'acme');
    const res = await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/members`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { email: 'b@example.com', role: 'MEMBER' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().role).toBe('MEMBER');
  });

  it('returns 404 when inviting an email no user has', async () => {
    const token = await registerUser('a@example.com');
    const team = await createTeam(token, 'acme');
    const res = await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/members`,
      headers: { authorization: `Bearer ${token}` },
      payload: { email: 'ghost@example.com', role: 'MEMBER' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('MEMBER cannot add other members (403)', async () => {
    const tokenA = await registerUser('a@example.com');
    const tokenB = await registerUser('b@example.com');
    await registerUser('c@example.com');
    const team = await createTeam(tokenA, 'acme');

    // A invites B as MEMBER.
    await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/members`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { email: 'b@example.com', role: 'MEMBER' },
    });

    // B (now a MEMBER) tries to add C — should be denied.
    const res = await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/members`,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { email: 'c@example.com', role: 'MEMBER' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuses to remove the last MANAGER', async () => {
    const token = await registerUser('a@example.com');
    const team = await createTeam(token, 'acme');
    // Find the manager's userId.
    const detail = await inject({
      method: 'GET',
      url: `/api/teams/${team.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    const userId = detail.json().members[0].userId;

    const res = await inject({
      method: 'DELETE',
      url: `/api/teams/${team.id}/members/${userId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(409);
  });

  it('refuses to demote the last MANAGER', async () => {
    const token = await registerUser('a@example.com');
    const team = await createTeam(token, 'acme');
    const detail = await inject({
      method: 'GET',
      url: `/api/teams/${team.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    const userId = detail.json().members[0].userId;

    const res = await inject({
      method: 'PATCH',
      url: `/api/teams/${team.id}/members/${userId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { role: 'MEMBER' },
    });
    expect(res.statusCode).toBe(409);
  });
});

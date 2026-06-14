import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { GlobalRole } from '@prisma/client';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { SYSTEM_USER_EMAIL } from '../../src/lib/systemUser.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';

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
  await prisma.teamMembership.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
});

async function inject(opts: Parameters<FastifyInstance['inject']>[0]) {
  return app.inject(opts);
}

const PASSWORD = 'CorrectHorseBattery9';

async function manager() {
  return bootstrapUser(app, {
    email: 'mgr@example.com',
    name: 'Manager',
    password: PASSWORD,
    globalRole: GlobalRole.MEMBER,
  });
}

async function plainMember() {
  return bootstrapUser(app, {
    email: 'member@example.com',
    name: 'Member',
    password: PASSWORD,
    globalRole: GlobalRole.MEMBER,
  });
}

async function createTeam(token: string, slug: string) {
  return (
    await inject({
      method: 'POST',
      url: '/api/teams',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'T', slug },
    })
  ).json() as { id: string };
}

type SearchHit = { id: string; email: string; name: string; alreadyMember: boolean };

async function userSearch(token: string, teamId: string, q: string) {
  const res = await inject({
    method: 'GET',
    url: `/api/teams/${teamId}/members/user-search?q=${encodeURIComponent(q)}`,
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: res.statusCode, body: res.json() as { items: SearchHit[] } };
}

describe('GET /api/teams/:teamId/members/user-search + add member picker (v1.57)', () => {
  it('1. search "al" returns matches by name and email, excludes disabled, capped at 20', async () => {
    const mgr = await manager();
    const team = await createTeam(mgr.token, 'search-1');
    await prisma.user.create({
      data: {
        email: 'alice@example.com',
        name: 'Alice Smith',
        passwordHash: 'x',
      },
    });
    await prisma.user.create({
      data: {
        email: 'ali.khan@corp.com',
        name: 'Khan',
        passwordHash: 'x',
      },
    });
    await prisma.user.create({
      data: {
        email: 'disabled@example.com',
        name: 'Ali Disabled',
        passwordHash: 'x',
        disabledAt: new Date(),
      },
    });
    for (let i = 0; i < 25; i++) {
      await prisma.user.create({
        data: {
          email: `zzalbulk${String(i).padStart(2, '0')}@example.com`,
          name: `ZZ Al Bulk ${i}`,
          passwordHash: 'x',
        },
      });
    }

    const { status, body } = await userSearch(mgr.token, team.id, 'al');
    expect(status).toBe(200);
    expect(body.items.length).toBe(20);
    expect(body.items.some((u) => u.email === 'alice@example.com')).toBe(true);
    expect(body.items.some((u) => u.email === 'ali.khan@corp.com')).toBe(true);
    expect(body.items.some((u) => u.email === 'disabled@example.com')).toBe(false);
    expect(body.items.some((u) => u.email.startsWith('zzalbulk'))).toBe(true);
  });

  it('2. query shorter than 2 chars returns empty list', async () => {
    const mgr = await manager();
    const team = await createTeam(mgr.token, 'search-2');
    await prisma.user.create({
      data: { email: 'a@example.com', name: 'A', passwordHash: 'x' },
    });

    const { status, body } = await userSearch(mgr.token, team.id, 'a');
    expect(status).toBe(200);
    expect(body.items).toHaveLength(0);
  });

  it('3. MANAGER with invite permission can search; plain MEMBER without gets 403', async () => {
    const mgr = await manager();
    const mem = await plainMember();
    const team = await createTeam(mgr.token, 'search-3');
    await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/members`,
      headers: { authorization: `Bearer ${mgr.token}` },
      payload: { email: mem.email, role: 'MEMBER' },
    });

    const allowed = await userSearch(mgr.token, team.id, 'mem');
    expect(allowed.status).toBe(200);

    const denied = await userSearch(mem.token, team.id, 'mem');
    expect(denied.status).toBe(403);
  });

  it('4. adding via userId creates membership with role and roleId; duplicate conflicts', async () => {
    const mgr = await manager();
    const bob = await bootstrapUser(app, {
      email: 'bob@example.com',
      name: 'Bob',
      password: PASSWORD,
      globalRole: GlobalRole.MEMBER,
    });
    const team = await createTeam(mgr.token, 'search-4');

    const add = await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/members`,
      headers: { authorization: `Bearer ${mgr.token}` },
      payload: { userId: bob.userId, role: 'MEMBER' },
    });
    expect(add.statusCode).toBe(201);
    const row = add.json() as { role: string; roleId: string | null };
    expect(row.role).toBe('MEMBER');
    expect(row.roleId).toBeTruthy();

    const dup = await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/members`,
      headers: { authorization: `Bearer ${mgr.token}` },
      payload: { userId: bob.userId, role: 'MEMBER' },
    });
    expect(dup.statusCode).toBe(409);
  });

  it('5. already-members are flagged alreadyMember in search results', async () => {
    const mgr = await manager();
    const bob = await bootstrapUser(app, {
      email: 'bob@example.com',
      name: 'Bob',
      password: PASSWORD,
      globalRole: GlobalRole.MEMBER,
    });
    const team = await createTeam(mgr.token, 'search-5');
    await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/members`,
      headers: { authorization: `Bearer ${mgr.token}` },
      payload: { email: bob.email, role: 'MEMBER' },
    });

    const { body } = await userSearch(mgr.token, team.id, 'bob');
    const hit = body.items.find((u) => u.email === 'bob@example.com');
    expect(hit?.alreadyMember).toBe(true);
  });

  it('6. system user never appears in search results', async () => {
    const mgr = await manager();
    const team = await createTeam(mgr.token, 'search-6');
    await prisma.user.create({
      data: {
        email: SYSTEM_USER_EMAIL,
        name: 'System',
        passwordHash: 'x',
        globalRole: GlobalRole.ADMIN,
        isSystemUser: true,
      },
    });

    const { body } = await userSearch(mgr.token, team.id, 'system');
    expect(body.items.some((u) => u.email === SYSTEM_USER_EMAIL)).toBe(false);
  });

  it('7. email-based add path still works (backward compat)', async () => {
    const mgr = await manager();
    await bootstrapUser(app, {
      email: 'legacy@example.com',
      name: 'Legacy',
      password: PASSWORD,
      globalRole: GlobalRole.MEMBER,
    });
    const team = await createTeam(mgr.token, 'search-7');

    const res = await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/members`,
      headers: { authorization: `Bearer ${mgr.token}` },
      payload: { email: 'legacy@example.com', role: 'MANAGER' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().role).toBe('MANAGER');
  });
});

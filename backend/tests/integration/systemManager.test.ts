import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { GlobalRole } from '@prisma/client';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { clearSystemUserCache, SYSTEM_USER_EMAIL } from '../../src/lib/systemUser.js';
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
  await prisma.teamMembership.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
  clearSystemUserCache();
});

async function inject(opts: Parameters<FastifyInstance['inject']>[0]) {
  return app.inject(opts);
}

async function ensureSystemUser() {
  return bootstrapUser(app, {
    email: SYSTEM_USER_EMAIL,
    name: 'System Admin',
    password: 'SysAdminPass9!',
    globalRole: GlobalRole.ADMIN,
    isSystemUser: true,
  });
}

describe('hidden system team manager', () => {
  it('auto-assigns system user as MANAGER on team create and hides from API', async () => {
    await ensureSystemUser();
    const human = await bootstrapUser(app, {
      email: 'human@example.com',
      name: 'Human',
      password: 'HumanPass9!!',
    });

    const created = await inject({
      method: 'POST',
      url: '/api/teams',
      headers: { authorization: `Bearer ${human.token}` },
      payload: { name: 'Ops', slug: 'ops' },
    });
    expect(created.statusCode).toBe(201);
    const team = created.json();

    const systemMembership = await prisma.teamMembership.findFirst({
      where: { teamId: team.id, user: { isSystemUser: true } },
    });
    expect(systemMembership?.role).toBe('MANAGER');

    const detail = await inject({
      method: 'GET',
      url: `/api/teams/${team.id}`,
      headers: { authorization: `Bearer ${human.token}` },
    });
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(body.members).toHaveLength(1);
    expect(body.members[0].email).toBe('human@example.com');
    expect(body.members.every((m: { email: string }) => m.email !== SYSTEM_USER_EMAIL)).toBe(true);
  });

  it('refuses to remove or demote the system manager', async () => {
    const system = await ensureSystemUser();
    const human = await bootstrapUser(app, {
      email: 'mgr@example.com',
      name: 'Mgr',
      password: 'MgrPass9!!!!',
      globalRole: GlobalRole.ADMIN,
    });
    const teamRes = await inject({
      method: 'POST',
      url: '/api/teams',
      headers: { authorization: `Bearer ${human.token}` },
      payload: { name: 'T', slug: `t-${Date.now()}` },
    });
    expect(teamRes.statusCode).toBe(201);
    const team = teamRes.json() as { id: string };

    const remove = await inject({
      method: 'DELETE',
      url: `/api/teams/${team.id}/members/${system.userId}`,
      headers: { authorization: `Bearer ${human.token}` },
    });
    expect(remove.statusCode).toBe(409);

    const demote = await inject({
      method: 'PATCH',
      url: `/api/teams/${team.id}/members/${system.userId}`,
      headers: { authorization: `Bearer ${human.token}` },
      payload: { role: 'MEMBER' },
    });
    expect(demote.statusCode).toBe(409);
  });

  it('blocks removing the last human MANAGER even when system manager exists', async () => {
    await ensureSystemUser();
    const human = await bootstrapUser(app, {
      email: 'solo@example.com',
      name: 'Solo',
      password: 'SoloPass9!!!',
    });
    const teamRes = await inject({
      method: 'POST',
      url: '/api/teams',
      headers: { authorization: `Bearer ${human.token}` },
      payload: { name: 'Solo Team', slug: 'solo' },
    });
    const team = teamRes.json();

    const remove = await inject({
      method: 'DELETE',
      url: `/api/teams/${team.id}/members/${human.userId}`,
      headers: { authorization: `Bearer ${human.token}` },
    });
    expect(remove.statusCode).toBe(409);
  });

  it('excludes system user from admin user list', async () => {
    await ensureSystemUser();
    const admin = await bootstrapUser(app, {
      email: 'visible@example.com',
      name: 'Visible',
      password: 'VisiblePass9!',
      globalRole: GlobalRole.ADMIN,
    });

    const res = await inject({
      method: 'GET',
      url: '/api/admin/users',
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.some((u: { email: string }) => u.email === SYSTEM_USER_EMAIL)).toBe(false);
    expect(body.items.some((u: { email: string }) => u.email === 'visible@example.com')).toBe(true);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';

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
  await prisma.notification.deleteMany();
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

async function register(email: string): Promise<{ token: string; userId: string; role: 'ADMIN' | 'MEMBER' }> {
  const res = await inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, name: email.split('@')[0], password: PASSWORD },
  });
  const body = res.json();
  return { token: body.accessToken, userId: body.user.id, role: body.user.globalRole };
}

describe('admin RBAC', () => {
  it('rejects MEMBER callers with 403', async () => {
    await register('first@example.com'); // becomes ADMIN (first user)
    const member = await register('second@example.com'); // MEMBER
    const res = await inject({
      method: 'GET',
      url: '/api/admin/users',
      headers: { authorization: `Bearer ${member.token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects unauthenticated callers with 401', async () => {
    const res = await inject({ method: 'GET', url: '/api/admin/users' });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /api/admin/users', () => {
  it('lists users with membership counts', async () => {
    const admin = await register('admin@example.com');
    expect(admin.role).toBe('ADMIN');
    const member = await register('member@example.com');
    // Create a team to bump admin's membership count.
    await inject({
      method: 'POST',
      url: '/api/teams',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { name: 'T', slug: 'team-t' },
    });

    const res = await inject({
      method: 'GET',
      url: '/api/admin/users',
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(res.statusCode).toBe(200);
    const users = res.json() as Array<{ email: string; globalRole: string; membershipCount: number }>;
    expect(users).toHaveLength(2);
    const adminRow = users.find((u) => u.email === 'admin@example.com')!;
    expect(adminRow.globalRole).toBe('ADMIN');
    expect(adminRow.membershipCount).toBe(1);
    expect(users.find((u) => u.email === 'member@example.com')!.membershipCount).toBe(0);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    void member;
  });
});

describe('PATCH /api/admin/users/:userId', () => {
  it('promotes a MEMBER to ADMIN', async () => {
    const admin = await register('admin@example.com');
    const member = await register('member@example.com');
    const res = await inject({
      method: 'PATCH',
      url: `/api/admin/users/${member.userId}`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { globalRole: 'ADMIN' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().globalRole).toBe('ADMIN');
  });

  it('refuses to demote the last ADMIN', async () => {
    const admin = await register('admin@example.com');
    await register('member@example.com');
    const res = await inject({
      method: 'PATCH',
      url: `/api/admin/users/${admin.userId}`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { globalRole: 'MEMBER' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('refuses self-demotion even when other admins exist', async () => {
    const admin = await register('admin@example.com');
    const second = await register('second@example.com');
    // Promote second to ADMIN so we have 2.
    await inject({
      method: 'PATCH',
      url: `/api/admin/users/${second.userId}`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { globalRole: 'ADMIN' },
    });
    // Now admin tries to demote themselves — still forbidden.
    const res = await inject({
      method: 'PATCH',
      url: `/api/admin/users/${admin.userId}`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { globalRole: 'MEMBER' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('allows another admin to demote a non-last admin', async () => {
    const a = await register('a@example.com');
    const b = await register('b@example.com');
    await inject({
      method: 'PATCH',
      url: `/api/admin/users/${b.userId}`,
      headers: { authorization: `Bearer ${a.token}` },
      payload: { globalRole: 'ADMIN' },
    });
    // a (ADMIN) demotes b (also ADMIN now) — allowed, two admins exist.
    const res = await inject({
      method: 'PATCH',
      url: `/api/admin/users/${b.userId}`,
      headers: { authorization: `Bearer ${a.token}` },
      payload: { globalRole: 'MEMBER' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().globalRole).toBe('MEMBER');
  });
});

describe('GET /api/admin/teams', () => {
  it('lists teams with member and project counts', async () => {
    const admin = await register('admin@example.com');
    const team = (
      await inject({
        method: 'POST',
        url: '/api/teams',
        headers: { authorization: `Bearer ${admin.token}` },
        payload: { name: 'Acme', slug: 'acme' },
      })
    ).json();
    await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { name: 'P' },
    });

    const res = await inject({
      method: 'GET',
      url: '/api/admin/teams',
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(res.statusCode).toBe(200);
    const teams = res.json() as Array<{ slug: string; memberCount: number; projectCount: number }>;
    const row = teams.find((t) => t.slug === 'acme')!;
    expect(row.memberCount).toBe(1);
    expect(row.projectCount).toBe(1);
  });
});

describe('DELETE /api/admin/teams/:teamId', () => {
  it('cascades through projects, tasks, comments, memberships', async () => {
    const admin = await register('admin@example.com');
    const team = (
      await inject({
        method: 'POST',
        url: '/api/teams',
        headers: { authorization: `Bearer ${admin.token}` },
        payload: { name: 'Acme', slug: 'acme' },
      })
    ).json();
    const project = (
      await inject({
        method: 'POST',
        url: `/api/teams/${team.id}/projects`,
        headers: { authorization: `Bearer ${admin.token}` },
        payload: { name: 'P' },
      })
    ).json();
    await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { title: 'T' },
    });

    const del = await inject({
      method: 'DELETE',
      url: `/api/admin/teams/${team.id}`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(del.statusCode).toBe(204);

    // Project + task should be gone via cascade.
    expect(await prisma.project.count({ where: { teamId: team.id } })).toBe(0);
    expect(await prisma.task.count({ where: { teamId: team.id } })).toBe(0);
    expect(await prisma.teamMembership.count({ where: { teamId: team.id } })).toBe(0);
  });
});

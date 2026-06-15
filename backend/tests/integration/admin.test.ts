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
  const r = await bootstrapUser(app, { email, name: email.split('@')[0], password: PASSWORD });
  const user = await prisma.user.findUnique({ where: { id: r.userId } });
  return { token: r.token, userId: r.userId, role: user!.globalRole as 'ADMIN' | 'MEMBER' };
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
    const page = res.json() as {
      items: Array<{ email: string; globalRole: string; membershipCount: number }>;
      page: number;
      totalItems: number;
      totalPages: number;
    };
    expect(page.items).toHaveLength(2);
    expect(page.totalItems).toBe(2);
    expect(page.page).toBe(1);
    const adminRow = page.items.find((u) => u.email === 'admin@example.com')!;
    expect(adminRow.globalRole).toBe('ADMIN');
    expect(adminRow.membershipCount).toBe(1);
    expect(page.items.find((u) => u.email === 'member@example.com')!.membershipCount).toBe(0);
    void member;
  });

  it('paginates with page numbers when more rows exist than the page size', async () => {
    const admin = await register('admin@example.com');
    for (let i = 0; i < 11; i++) {
      await register(`user${i}@example.com`);
    }

    const r1 = await inject({
      method: 'GET',
      url: '/api/admin/users?page=1&pageSize=10',
      headers: { authorization: `Bearer ${admin.token}` },
    });
    const p1 = r1.json() as {
      items: Array<{ id: string }>;
      page: number;
      totalPages: number;
      totalItems: number;
      pageSize: number;
    };
    expect(p1.items).toHaveLength(10);
    expect(p1.page).toBe(1);
    expect(p1.pageSize).toBe(10);
    expect(p1.totalItems).toBe(12);
    expect(p1.totalPages).toBe(2);

    const r2 = await inject({
      method: 'GET',
      url: '/api/admin/users?page=2&pageSize=10',
      headers: { authorization: `Bearer ${admin.token}` },
    });
    const p2 = r2.json() as { items: Array<{ id: string }>; page: number; totalPages: number };
    expect(p2.items).toHaveLength(2);
    expect(p2.page).toBe(2);
    expect(p2.totalPages).toBe(2);
    expect(new Set([...p1.items.map((u) => u.id), ...p2.items.map((u) => u.id)]).size).toBe(12);
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

  // v1.78.1: changing a user's globalRole revokes their refresh tokens.
  // The access JWT carries globalRole as a signed claim and requireAuth
  // doesn't re-read the DB on the JWT path, so without this the promoted
  // user would hit the API with stale role bits up to their refresh
  // token's lifetime. Forcing re-auth via the standard refresh→401 path
  // is the cheapest fix and bounded by the access TTL.
  it('revokes the targets refresh tokens when globalRole changes (v1.78.1)', async () => {
    const admin = await register('admin@example.com');
    // Bootstrap directly so we capture the fresh refresh cookie that
    // bootstrapUser returns (the `register` helper above discards it).
    const member = await bootstrapUser(app, {
      email: 'member@example.com',
      name: 'member',
      password: PASSWORD,
    });
    expect(member.refreshCookie).toBeTruthy();
    // Sanity: the member's refresh works before the promotion.
    const before = await inject({
      method: 'POST',
      url: '/api/auth/refresh',
      cookies: { th_refresh: member.refreshCookie! },
    });
    expect(before.statusCode).toBe(200);

    // Admin promotes member to ADMIN.
    const promote = await inject({
      method: 'PATCH',
      url: `/api/admin/users/${member.userId}`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { globalRole: 'ADMIN' },
    });
    expect(promote.statusCode).toBe(200);

    // The original refresh cookie is now revoked — the SPA must log in
    // again to get a JWT carrying the new globalRole. Either 401 or the
    // family-revocation 401 is acceptable; only the rotated cookie from
    // `before` would still work for one more rotation, and we throw it
    // away by re-using the original.
    const after = await inject({
      method: 'POST',
      url: '/api/auth/refresh',
      cookies: { th_refresh: member.refreshCookie! },
    });
    expect(after.statusCode).toBe(401);
  });

  // v1.78.1: a no-op role change (PATCH from ADMIN to ADMIN, etc.) must
  // NOT revoke refresh tokens — otherwise an admin editing some other
  // field that happens to round-trip globalRole would log themselves out.
  it('does NOT revoke refresh tokens when the role is unchanged (v1.78.1)', async () => {
    const admin = await register('admin@example.com');
    const target = await bootstrapUser(app, {
      email: 't@example.com',
      name: 't',
      password: PASSWORD,
    });
    // Same role re-set: MEMBER → MEMBER.
    const patch = await inject({
      method: 'PATCH',
      url: `/api/admin/users/${target.userId}`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { globalRole: 'MEMBER' },
    });
    expect(patch.statusCode).toBe(200);
    const refresh = await inject({
      method: 'POST',
      url: '/api/auth/refresh',
      cookies: { th_refresh: target.refreshCookie! },
    });
    expect(refresh.statusCode).toBe(200);
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
    const page = res.json() as {
      items: Array<{ slug: string; memberCount: number; projectCount: number }>;
    };
    const row = page.items.find((t) => t.slug === 'acme')!;
    expect(row.memberCount).toBe(1);
    expect(row.projectCount).toBe(1);
  });
});

describe('DELETE /api/admin/users/:userId', () => {
  it('deletes a user; their projects/tasks/comments survive with null attribution', async () => {
    const admin = await register('admin@example.com');
    const victim = await register('victim@example.com');

    // Victim owns a project, creates a task, comments on it.
    const team = (
      await inject({
        method: 'POST',
        url: '/api/teams',
        headers: { authorization: `Bearer ${victim.token}` },
        payload: { name: 'V', slug: 'team-v' },
      })
    ).json();
    const project = (
      await inject({
        method: 'POST',
        url: `/api/teams/${team.id}/projects`,
        headers: { authorization: `Bearer ${victim.token}` },
        payload: { name: 'P' },
      })
    ).json();
    const task = (
      await inject({
        method: 'POST',
        url: `/api/teams/${team.id}/projects/${project.id}/tasks`,
        headers: { authorization: `Bearer ${victim.token}` },
        payload: { title: 'T' },
      })
    ).json();
    await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks/${task.id}/comments`,
      headers: { authorization: `Bearer ${victim.token}` },
      payload: { body: 'mine' },
    });

    // Admin deletes victim.
    const del = await inject({
      method: 'DELETE',
      url: `/api/admin/users/${victim.userId}`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(del.statusCode).toBe(204);

    // Project survives but ownerId is null.
    const surviving = await prisma.project.findUnique({ where: { id: project.id } });
    expect(surviving).toBeTruthy();
    expect(surviving!.ownerId).toBeNull();

    // Task survives but creatorId is null.
    const survivingTask = await prisma.task.findUnique({ where: { id: task.id } });
    expect(survivingTask).toBeTruthy();
    expect(survivingTask!.creatorId).toBeNull();

    // Comment survives but authorId is null.
    const surviving_comments = await prisma.comment.findMany({ where: { taskId: task.id } });
    expect(surviving_comments).toHaveLength(1);
    expect(surviving_comments[0]!.authorId).toBeNull();
  });

  it('refuses to delete the last ADMIN', async () => {
    const admin = await register('admin@example.com');
    const res = await inject({
      method: 'DELETE',
      url: `/api/admin/users/${admin.userId}`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(res.statusCode).toBe(409);
  });

  it('refuses self-delete even with multiple admins', async () => {
    const a = await register('a@example.com');
    const b = await register('b@example.com');
    // Promote b to ADMIN.
    await inject({
      method: 'PATCH',
      url: `/api/admin/users/${b.userId}`,
      headers: { authorization: `Bearer ${a.token}` },
      payload: { globalRole: 'ADMIN' },
    });
    // a tries to delete themselves.
    const res = await inject({
      method: 'DELETE',
      url: `/api/admin/users/${a.userId}`,
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(res.statusCode).toBe(409);
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

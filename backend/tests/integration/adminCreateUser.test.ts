import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';

// v1.26: POST /api/admin/users — admin-provisioned account.
//   - admin-only (403 for members)
//   - explicit-password path: caller-supplied password works for login
//   - auto-generated password path: returned ONCE, works for login
//   - duplicate email rejected (409)
//   - password policy enforced (min 12, letters + digits)

let app: FastifyInstance;

beforeAll(async () => {
  const env = loadEnv();
  app = await buildApp(env);
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await prisma.refreshToken.deleteMany();
  await prisma.rolePermission.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.role.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
});

const PASSWORD = 'CorrectHorseBattery9';

async function inject(opts: Parameters<FastifyInstance['inject']>[0]) {
  return app.inject(opts);
}

async function setup() {
  const admin = await inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email: 'admin@example.com', name: 'Admin', password: PASSWORD },
  });
  const adminToken = admin.json().accessToken as string;

  const member = await inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email: 'mem@example.com', name: 'Mem', password: PASSWORD },
  });
  const memberToken = member.json().accessToken as string;

  return { adminToken, memberToken };
}

describe('POST /api/admin/users', () => {
  it('rejects non-admin callers with 403', async () => {
    const { memberToken } = await setup();
    const res = await inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: { authorization: `Bearer ${memberToken}` },
      payload: {
        email: 'new@example.com',
        name: 'New',
        password: 'AnotherStrongOne1',
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('admin can create a user with an explicit password; the new account can sign in', async () => {
    const { adminToken } = await setup();
    const create = await inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        email: 'newbie@example.com',
        name: 'Newbie',
        password: 'TestUserPass99',
      },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().user.email).toBe('newbie@example.com');
    expect(create.json().user.globalRole).toBe('MEMBER');
    expect(create.json().generatedPassword).toBeNull();
    // Admin-provisioned accounts default emailVerifiedAt = now.
    expect(create.json().user.emailVerifiedAt).toBeTruthy();

    // The new account can sign in immediately with the supplied password.
    const login = await inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'newbie@example.com', password: 'TestUserPass99' },
    });
    expect(login.statusCode).toBe(200);
  });

  it('omitting password makes the server generate one and return it once', async () => {
    const { adminToken } = await setup();
    const create = await inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        email: 'auto@example.com',
        name: 'Auto',
      },
    });
    expect(create.statusCode).toBe(201);
    const generated = create.json().generatedPassword as string;
    expect(typeof generated).toBe('string');
    expect(generated.length).toBeGreaterThanOrEqual(12);

    // Generated password satisfies the policy + lets the account in.
    const login = await inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'auto@example.com', password: generated },
    });
    expect(login.statusCode).toBe(200);
  });

  it('rejects a duplicate email with 409', async () => {
    const { adminToken } = await setup();
    const first = await inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { email: 'dup@example.com', name: 'A', password: 'Whatever12345' },
    });
    expect(first.statusCode).toBe(201);

    const second = await inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { email: 'dup@example.com', name: 'B', password: 'OtherWhatever9' },
    });
    expect(second.statusCode).toBe(409);
  });

  it('rejects a weak password with 400 (policy violation)', async () => {
    const { adminToken } = await setup();
    const res = await inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { email: 'weak@example.com', name: 'Weak', password: 'short' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('admin can promote on create by passing globalRole: ADMIN', async () => {
    const { adminToken } = await setup();
    const create = await inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        email: 'secondadmin@example.com',
        name: 'Second',
        password: 'AdminPass00001',
        globalRole: 'ADMIN',
      },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().user.globalRole).toBe('ADMIN');
  });
});

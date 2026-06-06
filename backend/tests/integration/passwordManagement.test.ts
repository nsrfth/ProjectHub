import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';

// v1.32.0: user-initiated password change + admin password reset. Together
// these are the two write paths into User.passwordHash (besides
// admin-create + the existing reset-token flow). Both must:
//   - refuse directory-owned users (LDAP/SCIM password lives upstream),
//   - revoke every active refresh-token row for the target so other
//     devices get booted on next /refresh,
//   - leave the new password actually usable for login.

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
  await prisma.directoryGroupMapping.deleteMany();
  await prisma.directory.deleteMany();
  await prisma.user.deleteMany();
});

const OLD = 'CorrectHorseBattery9';
const NEW = 'BrandNewPassphrase42!';

function login(email: string, password: string) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password },
  });
}

describe('POST /api/auth/me/password', () => {
  it('rotates the password and revokes other refresh tokens', async () => {
    const me = await bootstrapUser(app, { email: 'me@example.com', password: OLD });

    // A second device — log the same user in twice so we have two live
    // refresh-token rows we can later check were revoked.
    const secondDevice = await login('me@example.com', OLD);
    expect(secondDevice.statusCode).toBe(200);
    const liveBefore = await prisma.refreshToken.count({
      where: { userId: me.userId, revokedAt: null },
    });
    expect(liveBefore).toBeGreaterThanOrEqual(2);

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/me/password',
      headers: { authorization: `Bearer ${me.token}` },
      payload: { currentPassword: OLD, newPassword: NEW },
    });
    expect(res.statusCode).toBe(204);

    // Old password no longer works; new one does.
    expect((await login('me@example.com', OLD)).statusCode).toBe(401);
    expect((await login('me@example.com', NEW)).statusCode).toBe(200);

    // Every pre-existing refresh-token row was revoked.
    const liveAfter = await prisma.refreshToken.count({
      where: {
        userId: me.userId,
        revokedAt: null,
        // Exclude the just-issued one from the NEW-password login above.
        createdAt: { lt: new Date(Date.now() - 100) },
      },
    });
    expect(liveAfter).toBe(0);
  });

  it('rejects a wrong current password with 400 and does not rotate', async () => {
    const me = await bootstrapUser(app, { email: 'me@example.com', password: OLD });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/me/password',
      headers: { authorization: `Bearer ${me.token}` },
      payload: { currentPassword: 'wrong-password', newPassword: NEW },
    });
    expect(res.statusCode).toBe(400);
    // Old password still works.
    expect((await login('me@example.com', OLD)).statusCode).toBe(200);
  });

  it('rejects a new password that fails the policy with 400', async () => {
    const me = await bootstrapUser(app, { email: 'me@example.com', password: OLD });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/me/password',
      headers: { authorization: `Bearer ${me.token}` },
      payload: { currentPassword: OLD, newPassword: 'short' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects directory-owned users with 403 even with the correct current password', async () => {
    const me = await bootstrapUser(app, { email: 'me@example.com', password: OLD });
    // Pretend this user was provisioned by an LDAP directory: directoryId
    // gets set on the User row by the directoryService at JIT time.
    const dir = await prisma.directory.create({
      data: { name: 'corp-ldap', slug: 'corp-ldap', kind: 'LDAP' },
    });
    await prisma.user.update({
      where: { id: me.userId },
      data: { directoryId: dir.id, externalId: 'uid=me,ou=people,dc=corp' },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/me/password',
      headers: { authorization: `Bearer ${me.token}` },
      payload: { currentPassword: OLD, newPassword: NEW },
    });
    expect(res.statusCode).toBe(403);
  });

  it('requires authentication — 401 without a token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/me/password',
      payload: { currentPassword: OLD, newPassword: NEW },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /api/admin/users/:userId/password', () => {
  async function bootstrapAdminAndMember() {
    const admin = await bootstrapUser(app, {
      email: 'admin@example.com',
      password: OLD,
      globalRole: 'ADMIN',
    });
    const member = await bootstrapUser(app, {
      email: 'member@example.com',
      password: OLD,
      globalRole: 'MEMBER',
    });
    return { admin, member };
  }

  it('with no password supplied, generates one, returns it once, and the user can log in with it', async () => {
    const { admin, member } = await bootstrapAdminAndMember();
    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/users/${member.userId}/password`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const generated = res.json().generatedPassword as string;
    expect(typeof generated).toBe('string');
    expect(generated.length).toBeGreaterThanOrEqual(12);
    // Old password no longer works; the generated one does.
    expect((await login('member@example.com', OLD)).statusCode).toBe(401);
    expect((await login('member@example.com', generated)).statusCode).toBe(200);
  });

  it('with a caller-supplied password, uses it and returns generatedPassword: null', async () => {
    const { admin, member } = await bootstrapAdminAndMember();
    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/users/${member.userId}/password`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { password: NEW },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().generatedPassword).toBeNull();
    expect((await login('member@example.com', NEW)).statusCode).toBe(200);
  });

  it('revokes every active refresh-token row for the target', async () => {
    const { admin, member } = await bootstrapAdminAndMember();
    // Member logs in a second time so there are two live rows.
    await login('member@example.com', OLD);
    const before = await prisma.refreshToken.count({
      where: { userId: member.userId, revokedAt: null },
    });
    expect(before).toBeGreaterThanOrEqual(2);

    await app.inject({
      method: 'POST',
      url: `/api/admin/users/${member.userId}/password`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { password: NEW },
    });

    const after = await prisma.refreshToken.count({
      where: { userId: member.userId, revokedAt: null },
    });
    expect(after).toBe(0);
  });

  it('rejects directory-owned targets with 409', async () => {
    const { admin, member } = await bootstrapAdminAndMember();
    const dir = await prisma.directory.create({
      data: { name: 'corp-ldap-2', slug: 'corp-ldap-2', kind: 'LDAP' },
    });
    await prisma.user.update({
      where: { id: member.userId },
      data: { directoryId: dir.id, externalId: 'uid=member,ou=people' },
    });

    const hashBefore = (await prisma.user.findUnique({
      where: { id: member.userId },
      select: { passwordHash: true },
    }))!.passwordHash;

    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/users/${member.userId}/password`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { password: NEW },
    });
    expect(res.statusCode).toBe(409);

    // passwordHash is untouched — once a user is directory-owned, only the
    // directory should rewrite it. Local login may now route through the
    // directory (and return 400/401 depending on config), so we check the
    // stored hash directly instead of probing the login endpoint.
    const hashAfter = (await prisma.user.findUnique({
      where: { id: member.userId },
      select: { passwordHash: true },
    }))!.passwordHash;
    expect(hashAfter).toBe(hashBefore);
  });

  it('rejects an unknown user with 404', async () => {
    const admin = await bootstrapUser(app, {
      email: 'admin@example.com',
      password: OLD,
      globalRole: 'ADMIN',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/users/nope-no-such-id/password`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it('non-admin caller gets 403', async () => {
    const { member } = await bootstrapAdminAndMember();
    const other = await bootstrapUser(app, {
      email: 'other@example.com',
      password: OLD,
      globalRole: 'MEMBER',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/users/${member.userId}/password`,
      headers: { authorization: `Bearer ${other.token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a caller-supplied password that fails the policy', async () => {
    const { admin, member } = await bootstrapAdminAndMember();
    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/users/${member.userId}/password`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { password: 'tooshort' },
    });
    expect(res.statusCode).toBe(400);
  });
});

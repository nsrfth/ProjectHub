import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';

// Regression: `team.manage_roles` used to be a self-service escalation to every
// other team permission. Its holder could mint a role carrying
// project.write_all (or widen the system Member role) and then assign it to
// themselves via PATCH /teams/:id/members/:userId, which the default Manager
// also holds through team.change_role. Nothing checked that you already held
// what you were granting.
//
// Both write paths — create and setPermissions — now go through the same
// boundary, because bounding only one leaves the other as a complete bypass.
// Global ADMIN is deliberately exempt, matching every other gate in the
// codebase.
//
// Also pins the audit rows for role and global-role mutations.

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
  await prisma.activity.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.rolePermission.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.role.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
});

const PASSWORD = 'CorrectHorseBattery9';
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/**
 * Admin + a second user who is a team MANAGER holding a NARROWED role: it has
 * team.manage_roles and team.change_role (so they may reach the role routes at
 * all) but deliberately NOT project.write_all — that is the permission the
 * boundary must stop them handing to themselves.
 */
async function setup() {
  const admin = await bootstrapUser(app, {
    email: 'admin@example.com',
    name: 'Admin',
    password: PASSWORD,
  });
  const deputy = await bootstrapUser(app, {
    email: 'deputy@example.com',
    name: 'Deputy',
    password: PASSWORD,
  });

  const team = await app.inject({
    method: 'POST',
    url: '/api/teams',
    headers: auth(admin.token),
    payload: { name: 'boundary', slug: 'boundary' },
  });
  const teamId = team.json().id as string;

  await app.inject({
    method: 'POST',
    url: `/api/teams/${teamId}/members`,
    headers: auth(admin.token),
    payload: { email: 'deputy@example.com', role: 'MANAGER' },
  });

  const narrowed = await prisma.role.create({
    data: {
      teamId,
      name: 'Narrowed Manager',
      isSystem: false,
      permissions: {
        create: [
          { permission: 'team.manage_roles' },
          { permission: 'team.change_role' },
          { permission: 'task.delete' },
        ],
      },
    },
  });
  await prisma.teamMembership.updateMany({
    where: { teamId, userId: deputy.userId },
    data: { roleId: narrowed.id },
  });

  return { admin, deputy, teamId, narrowedRoleId: narrowed.id };
}

describe('role permission boundary', () => {
  it('blocks creating a role carrying a permission the actor does not hold', async () => {
    const { deputy, teamId } = await setup();

    const res = await app.inject({
      method: 'POST',
      url: `/api/teams/${teamId}/roles`,
      headers: auth(deputy.token),
      payload: { name: 'Escalated', permissions: ['project.write_all'] },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toContain('project.write_all');
    expect(await prisma.role.count({ where: { teamId, name: 'Escalated' } })).toBe(0);
  });

  it('blocks adding an unheld permission to an existing role', async () => {
    const { deputy, teamId, narrowedRoleId } = await setup();

    const res = await app.inject({
      method: 'PUT',
      url: `/api/teams/${teamId}/roles/${narrowedRoleId}/permissions`,
      headers: auth(deputy.token),
      payload: {
        permissions: ['team.manage_roles', 'team.change_role', 'project.write_all'],
      },
    });

    expect(res.statusCode).toBe(403);
    const still = await prisma.rolePermission.findMany({ where: { roleId: narrowedRoleId } });
    expect(still.map((p) => p.permission)).not.toContain('project.write_all');
  });

  it('still allows granting a permission the actor does hold', async () => {
    const { deputy, teamId } = await setup();

    const res = await app.inject({
      method: 'POST',
      url: `/api/teams/${teamId}/roles`,
      headers: auth(deputy.token),
      payload: { name: 'Fine', permissions: ['task.delete'] },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().permissions).toEqual(['task.delete']);
  });

  it('still allows narrowing a role that carries a permission the actor lacks', async () => {
    const { admin, deputy, teamId } = await setup();

    // Admin mints a role the deputy could never have created.
    const broad = await app.inject({
      method: 'POST',
      url: `/api/teams/${teamId}/roles`,
      headers: auth(admin.token),
      payload: { name: 'Broad', permissions: ['project.write_all', 'task.delete'] },
    });
    const broadId = broad.json().id as string;

    // The deputy may still REMOVE it — only additions are bounded.
    const res = await app.inject({
      method: 'PUT',
      url: `/api/teams/${teamId}/roles/${broadId}/permissions`,
      headers: auth(deputy.token),
      payload: { permissions: ['task.delete'] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().permissions).toEqual(['task.delete']);
  });

  it('exempts global ADMIN', async () => {
    const { admin, teamId } = await setup();

    const res = await app.inject({
      method: 'POST',
      url: `/api/teams/${teamId}/roles`,
      headers: auth(admin.token),
      payload: { name: 'AdminMade', permissions: ['project.write_all'] },
    });

    expect(res.statusCode).toBe(201);
  });
});

describe('privileged-action audit rows', () => {
  it('records who changed a role permission set, with the diff', async () => {
    const { admin, teamId, narrowedRoleId } = await setup();

    await app.inject({
      method: 'PUT',
      url: `/api/teams/${teamId}/roles/${narrowedRoleId}/permissions`,
      headers: auth(admin.token),
      payload: { permissions: ['team.manage_roles', 'project.write_all'] },
    });

    const row = await prisma.activity.findFirst({
      where: { teamId, action: 'role.permissions_changed' },
    });
    expect(row).not.toBeNull();
    expect(row?.actorId).toBe(admin.userId);
    expect(row?.meta).toMatchObject({ roleId: narrowedRoleId });
    const meta = row?.meta as { added: string[]; removed: string[] };
    expect(meta.added).toContain('project.write_all');
    expect(meta.removed).toContain('team.change_role');
  });

  it('records a global role change with both endpoints', async () => {
    const { admin, deputy } = await setup();

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${deputy.userId}`,
      headers: auth(admin.token),
      payload: { globalRole: 'ADMIN' },
    });
    expect(res.statusCode).toBe(200);

    const row = await prisma.activity.findFirst({
      where: { action: 'admin.user.role_changed' },
    });
    expect(row).not.toBeNull();
    expect(row?.actorId).toBe(admin.userId);
    expect(row?.meta).toMatchObject({
      targetUserId: deputy.userId,
      from: 'MEMBER',
      to: 'ADMIN',
    });
  });
});

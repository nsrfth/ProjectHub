import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';

// v1.23: roles CRUD + permission system.
//  - creating a team auto-creates Manager + Member system roles
//  - admins can create / update / delete custom roles
//  - members get 403 on writes (team.manage_roles permission gate)
//  - system roles can be edited (permissions only) but not deleted
//  - custom role with members can't be deleted (409)
//  - PATCH /members/:userId accepts both `role` (legacy) and `roleId`
//  - permission gates work end-to-end (technician change)

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
  await prisma.subtask.deleteMany();
  await prisma.task.deleteMany();
  await prisma.project.deleteMany();
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
  const adminId = admin.json().user.id as string;

  const member = await inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email: 'mem@example.com', name: 'Mem', password: PASSWORD },
  });
  const memberToken = member.json().accessToken as string;
  const memberId = member.json().user.id as string;

  const team = await inject({
    method: 'POST',
    url: '/api/teams',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { name: 'RoleTeam', slug: 'role-team' },
  });
  const teamId = team.json().id as string;

  // Add member.
  await inject({
    method: 'POST',
    url: `/api/teams/${teamId}/members`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { email: 'mem@example.com', role: 'MEMBER' },
  });

  return { adminToken, adminId, memberToken, memberId, teamId };
}

async function ensureSystemRoles(teamId: string) {
  // Tests truncate Role between fixtures, so we need to recreate the system
  // roles by hand when a test wants the full backend wired up. Mirrors the
  // seed shape (Manager: all 14 perms; Member: task.delete + task.modify_dates).
  const allPerms = [
    'task.delete',
    'task.modify_dates',
    'task.change_technician',
    'task.change_assignee',
    'comment.delete_others',
    'project.edit',
    'project.delete',
    'project.set_accountable',
    'team.invite_member',
    'team.remove_member',
    'team.change_role',
    'team.manage_roles',
    'webhooks.manage',
    'trash.purge',
  ];
  const mgr = await prisma.role.create({
    data: {
      teamId,
      name: 'Manager',
      isSystem: true,
      permissions: { create: allPerms.map((p) => ({ permission: p })) },
    },
  });
  const mem = await prisma.role.create({
    data: {
      teamId,
      name: 'Member',
      isSystem: true,
      permissions: { create: [{ permission: 'task.delete' }, { permission: 'task.modify_dates' }] },
    },
  });
  await prisma.teamMembership.updateMany({
    where: { teamId, role: 'MANAGER' },
    data: { roleId: mgr.id },
  });
  await prisma.teamMembership.updateMany({
    where: { teamId, role: 'MEMBER' },
    data: { roleId: mem.id },
  });
  return { managerRoleId: mgr.id, memberRoleId: mem.id };
}

describe('roles CRUD', () => {
  it('lists system roles after migration / seed', async () => {
    const { adminToken, teamId } = await setup();
    await ensureSystemRoles(teamId);
    const res = await inject({
      method: 'GET',
      url: `/api/teams/${teamId}/roles`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const names = (res.json().items as Array<{ name: string; isSystem: boolean }>).map((r) => r.name).sort();
    expect(names).toEqual(['Manager', 'Member']);
    expect(res.json().items.every((r: { isSystem: boolean }) => r.isSystem)).toBe(true);
  });

  it('admin can create a custom role with a permission subset', async () => {
    const { adminToken, teamId } = await setup();
    await ensureSystemRoles(teamId);
    const res = await inject({
      method: 'POST',
      url: `/api/teams/${teamId}/roles`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: 'Senior Manager',
        description: 'Can change technicians + purge trash',
        permissions: ['task.change_technician', 'trash.purge'],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().name).toBe('Senior Manager');
    expect(res.json().permissions.sort()).toEqual(['task.change_technician', 'trash.purge']);
    expect(res.json().isSystem).toBe(false);
  });

  it('rejects an unknown permission string (400)', async () => {
    const { adminToken, teamId } = await setup();
    await ensureSystemRoles(teamId);
    const res = await inject({
      method: 'POST',
      url: `/api/teams/${teamId}/roles`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'Bogus', permissions: ['fake.permission'] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/permission/i);
  });

  it('member without team.manage_roles cannot create a role (403)', async () => {
    const { memberToken, teamId } = await setup();
    await ensureSystemRoles(teamId);
    const res = await inject({
      method: 'POST',
      url: `/api/teams/${teamId}/roles`,
      headers: { authorization: `Bearer ${memberToken}` },
      payload: { name: 'X', permissions: [] },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects deletion of a system role (400)', async () => {
    const { adminToken, teamId } = await setup();
    const { managerRoleId } = await ensureSystemRoles(teamId);
    const res = await inject({
      method: 'DELETE',
      url: `/api/teams/${teamId}/roles/${managerRoleId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/system/i);
  });

  it('rejects deletion of a custom role with assigned members (409)', async () => {
    const { adminToken, memberId, teamId } = await setup();
    await ensureSystemRoles(teamId);
    const created = await inject({
      method: 'POST',
      url: `/api/teams/${teamId}/roles`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'Custom', permissions: [] },
    });
    const customId = created.json().id as string;
    // Assign member to it.
    await inject({
      method: 'PATCH',
      url: `/api/teams/${teamId}/members/${memberId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { roleId: customId },
    });
    const del = await inject({
      method: 'DELETE',
      url: `/api/teams/${teamId}/roles/${customId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(del.statusCode).toBe(409);
  });
});

describe('PATCH /members/:userId with roleId', () => {
  it('admin assigns a custom roleId to a member', async () => {
    const { adminToken, memberId, teamId } = await setup();
    await ensureSystemRoles(teamId);
    const created = await inject({
      method: 'POST',
      url: `/api/teams/${teamId}/roles`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'Lead', permissions: ['task.change_technician'] },
    });
    const leadId = created.json().id as string;

    const res = await inject({
      method: 'PATCH',
      url: `/api/teams/${teamId}/members/${memberId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { roleId: leadId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().roleId).toBe(leadId);
    expect(res.json().roleName).toBe('Lead');
  });

  it('rejects PATCH with both role and roleId (400)', async () => {
    const { adminToken, memberId, teamId } = await setup();
    await ensureSystemRoles(teamId);
    const res = await inject({
      method: 'PATCH',
      url: `/api/teams/${teamId}/members/${memberId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { role: 'MANAGER', roleId: 'doesnt-matter' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('permission gates end-to-end', () => {
  it('granting task.change_technician to a member via a custom role lets them change technicians', async () => {
    const { adminToken, memberToken, memberId, teamId } = await setup();
    await ensureSystemRoles(teamId);

    // Create a project + task as admin.
    const project = await inject({
      method: 'POST',
      url: `/api/teams/${teamId}/projects`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'P' },
    });
    const projectId = project.json().id as string;
    const task = await inject({
      method: 'POST',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { title: 'T' },
    });
    const taskId = task.json().id as string;

    // Member CANNOT change technician with default Member role.
    const before = await inject({
      method: 'PATCH',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks/${taskId}`,
      headers: { authorization: `Bearer ${memberToken}` },
      payload: { technicianId: memberId },
    });
    expect(before.statusCode).toBe(403);

    // Give the Member role the task.change_technician permission.
    const memberRole = await prisma.role.findFirst({
      where: { teamId, isSystem: true, name: 'Member' },
    });
    await inject({
      method: 'PUT',
      url: `/api/teams/${teamId}/roles/${memberRole!.id}/permissions`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { permissions: ['task.delete', 'task.modify_dates', 'task.change_technician'] },
    });

    // Member CAN now change technician.
    const after = await inject({
      method: 'PATCH',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks/${taskId}`,
      headers: { authorization: `Bearer ${memberToken}` },
      payload: { technicianId: memberId },
    });
    expect(after.statusCode).toBe(200);
    expect(after.json().technicianId).toBe(memberId);
  });
});

describe('/api/system/permissions catalog', () => {
  it('returns the 15 permission constants + UI groups', async () => {
    const res = await inject({ method: 'GET', url: '/api/system/permissions' });
    expect(res.statusCode).toBe(200);
    // v1.29 added `task.manage_dependencies`.
    expect(res.json().permissions).toHaveLength(15);
    expect(res.json().permissions).toContain('task.change_technician');
    expect(res.json().permissions).toContain('task.manage_dependencies');
    expect(res.json().groups.Tasks).toContain('task.delete');
    expect(res.json().groups.Tasks).toContain('task.manage_dependencies');
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';

// Regression: team-scoped reports and dashboard widgets used to be filtered by
// teamId ALONE. Project visibility is owner/grant-based, so a plain team MEMBER
// is 404'd out of a team project they neither own nor were granted — yet the
// reports surface handed them that project's task titles, assignees, overdue
// list and planned budget. `project.read_all` exists precisely as an
// oversight-only permission, and members do not hold it by default.
//
// These tests pin both directions: the un-entitled member sees nothing, and the
// owner / ADMIN still see everything (guarding against over-clamping the fix).
//
// Also covers: ownership transfer must leave an audit row, and a READ-only
// project grantee must not be able to submit an expense.

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
  await prisma.expense.deleteMany();
  await prisma.activity.deleteMany();
  await prisma.task.deleteMany();
  await prisma.projectGroupGrant.deleteMany();
  await prisma.userGroupMember.deleteMany();
  await prisma.userGroup.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.rolePermission.deleteMany();
  await prisma.project.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.role.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
  await prisma.instanceSetting.deleteMany();
});

const PASSWORD = 'CorrectHorseBattery9';
const MS_DAY = 86_400_000;
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

function utcMidnight(offsetDays = 0): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() + offsetDays * MS_DAY);
}

async function register(email: string, name = 'User') {
  const r = await bootstrapUser(app, { email, name, password: PASSWORD });
  return { token: r.token, userId: r.userId };
}

async function createTeam(token: string, slug: string): Promise<string> {
  const r = await app.inject({
    method: 'POST',
    url: '/api/teams',
    headers: auth(token),
    payload: { name: slug, slug },
  });
  if (r.statusCode !== 201) throw new Error(`createTeam: ${r.statusCode} ${r.body}`);
  return r.json().id as string;
}

async function createProject(token: string, teamId: string, name: string): Promise<string> {
  const r = await app.inject({
    method: 'POST',
    url: `/api/teams/${teamId}/projects`,
    headers: auth(token),
    payload: { name },
  });
  if (r.statusCode !== 201) throw new Error(`createProject: ${r.statusCode} ${r.body}`);
  return r.json().id as string;
}

async function addMember(
  adminToken: string,
  teamId: string,
  email: string,
  role: 'MEMBER' | 'MANAGER' = 'MEMBER',
): Promise<void> {
  const r = await app.inject({
    method: 'POST',
    url: `/api/teams/${teamId}/members`,
    headers: auth(adminToken),
    payload: { email, role },
  });
  if (r.statusCode !== 201) throw new Error(`addMember: ${r.statusCode} ${r.body}`);
}

async function seedTask(
  teamId: string,
  projectId: string,
  creatorId: string,
  title: string,
  data: { dueDate?: Date | null; completedAt?: Date | null; plannedBudget?: number } = {},
) {
  return prisma.task.create({
    data: {
      projectId,
      teamId,
      creatorId,
      title,
      status: data.completedAt ? 'DONE' : 'TODO',
      dueDate: data.dueDate ?? null,
      completedAt: data.completedAt ?? null,
      ...(data.plannedBudget !== undefined ? { plannedBudget: data.plannedBudget } : {}),
    },
  });
}

/**
 * Give `userId` READ-only access to `projectId` through the legacy group-grant
 * path (ACCESS_UNIFIED_GRANTS defaults to `off`). The member's accessLevel is
 * what decides FULL vs READONLY; the ProjectGroupGrant row is levelless.
 */
async function grantReadOnly(teamId: string, projectId: string, userId: string): Promise<void> {
  const group = await prisma.userGroup.create({
    data: { teamId, name: `ro-${userId.slice(0, 6)}` },
  });
  await prisma.userGroupMember.create({
    data: { groupId: group.id, userId, accessLevel: 'READONLY', status: 'ACCEPTED', role: 'MEMBER' },
  });
  await prisma.projectGroupGrant.create({ data: { projectId, groupId: group.id } });
}

describe('team reports are clamped to the caller’s visible projects', () => {
  it('hides a project the member cannot open from every report shape', async () => {
    const admin = await register('admin@example.com', 'Admin');
    const teamId = await createTeam(admin.token, 'scope-a');
    const projectId = await createProject(admin.token, teamId, 'Secret');

    const carol = await register('carol@example.com', 'Carol');
    await addMember(admin.token, teamId, 'carol@example.com');

    await seedTask(teamId, projectId, admin.userId, 'Overdue thing', {
      dueDate: utcMidnight(-3),
      plannedBudget: 5000,
    });
    await seedTask(teamId, projectId, admin.userId, 'Finished thing', {
      completedAt: new Date(Date.now() - MS_DAY),
    });

    // Premise: Carol is a team member but cannot open the project at all.
    const direct = await app.inject({
      method: 'GET',
      url: `/api/teams/${teamId}/projects/${projectId}`,
      headers: auth(carol.token),
    });
    expect(direct.statusCode).toBe(404);

    // ...so none of the aggregates may surface it either.
    const overdue = await app.inject({
      method: 'GET',
      url: `/api/teams/${teamId}/reports/overdue`,
      headers: auth(carol.token),
    });
    expect(overdue.statusCode).toBe(200);
    expect(overdue.json().items).toHaveLength(0);

    const done = await app.inject({
      method: 'GET',
      url: `/api/teams/${teamId}/reports/done?days=30`,
      headers: auth(carol.token),
    });
    expect(done.statusCode).toBe(200);
    expect(done.json().items).toHaveLength(0);

    const budget = await app.inject({
      method: 'GET',
      url: `/api/teams/${teamId}/reports/budget`,
      headers: auth(carol.token),
    });
    expect(budget.statusCode).toBe(200);
    expect(budget.json().projects).toHaveLength(0);

    const summary = await app.inject({
      method: 'GET',
      url: `/api/teams/${teamId}/reports/summary`,
      headers: auth(carol.token),
    });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().overdueCount).toBe(0);
    expect(summary.json().doneLast7Days).toBe(0);

    const workload = await app.inject({
      method: 'GET',
      url: `/api/teams/${teamId}/reports/workload`,
      headers: auth(carol.token),
    });
    expect(workload.statusCode).toBe(200);
    expect(workload.json().items).toHaveLength(0);
  });

  it('still shows the project to ADMIN and to its owner (no over-clamping)', async () => {
    const admin = await register('admin@example.com', 'Admin');
    const teamId = await createTeam(admin.token, 'scope-b');
    const projectId = await createProject(admin.token, teamId, 'Visible');

    const bob = await register('bob@example.com', 'Bob');
    await addMember(admin.token, teamId, 'bob@example.com');

    await seedTask(teamId, projectId, admin.userId, 'Overdue thing', {
      dueDate: utcMidnight(-3),
      plannedBudget: 5000,
    });

    // ADMIN keeps the full team-wide view.
    const adminOverdue = await app.inject({
      method: 'GET',
      url: `/api/teams/${teamId}/reports/overdue`,
      headers: auth(admin.token),
    });
    expect(adminOverdue.json().items).toHaveLength(1);

    // Hand the project to Bob; as owner he must now see it in reports.
    const transfer = await app.inject({
      method: 'PATCH',
      url: `/api/teams/${teamId}/projects/${projectId}`,
      headers: auth(admin.token),
      payload: { ownerId: bob.userId },
    });
    expect(transfer.statusCode).toBe(200);

    const bobOverdue = await app.inject({
      method: 'GET',
      url: `/api/teams/${teamId}/reports/overdue`,
      headers: auth(bob.token),
    });
    expect(bobOverdue.statusCode).toBe(200);
    expect(bobOverdue.json().items).toHaveLength(1);

    const bobBudget = await app.inject({
      method: 'GET',
      url: `/api/teams/${teamId}/reports/budget`,
      headers: auth(bob.token),
    });
    expect(bobBudget.json().projects).toHaveLength(1);
  });

  it('records an audit entry when a project changes owner', async () => {
    const admin = await register('admin@example.com', 'Admin');
    const teamId = await createTeam(admin.token, 'scope-c');
    const projectId = await createProject(admin.token, teamId, 'Handover');

    const bob = await register('bob@example.com', 'Bob');
    await addMember(admin.token, teamId, 'bob@example.com');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/teams/${teamId}/projects/${projectId}`,
      headers: auth(admin.token),
      payload: { ownerId: bob.userId },
    });
    expect(res.statusCode).toBe(200);

    const row = await prisma.activity.findFirst({
      where: { teamId, action: 'project.owner_transferred' },
    });
    expect(row).not.toBeNull();
    expect(row?.actorId).toBe(admin.userId);
    expect(row?.meta).toMatchObject({ projectId, from: admin.userId, to: bob.userId });
  });
});

describe('cost expenses require project WRITE', () => {
  it('rejects an expense submitted by a READ-only project grantee', async () => {
    const admin = await register('admin@example.com', 'Admin');
    const teamId = await createTeam(admin.token, 'cost-ro');
    const projectId = await createProject(admin.token, teamId, 'Budgeted');

    const enable = await app.inject({
      method: 'PUT',
      url: `/api/teams/${teamId}/projects/${projectId}/profile/overrides`,
      headers: auth(admin.token),
      payload: { overrides: { cost_control: { enabled: true } } },
    });
    expect(enable.statusCode).toBe(200);

    const reader = await register('reader@example.com', 'Reader');
    await addMember(admin.token, teamId, 'reader@example.com');
    await grantReadOnly(teamId, projectId, reader.userId);

    // Sanity: the grant really does give READ (otherwise the 403 below would
    // be a 404 and would not be testing the write gate at all).
    const canRead = await app.inject({
      method: 'GET',
      url: `/api/teams/${teamId}/projects/${projectId}/cost/summary`,
      headers: auth(reader.token),
    });
    expect(canRead.statusCode).toBe(200);

    const res = await app.inject({
      method: 'POST',
      url: `/api/teams/${teamId}/projects/${projectId}/cost/expenses`,
      headers: auth(reader.token),
      payload: { amountMinor: 1000, currency: 'IRR', incurredOn: '2026-01-01' },
    });
    expect(res.statusCode).toBe(403);
    expect(await prisma.expense.count()).toBe(0);
  });
});

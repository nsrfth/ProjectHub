import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';

// v1.34: per-project bucket grouping.
//
// Covers:
//   - CRUD: create / list / rename / delete with cross-tenant 404s
//   - Reorder: full-permutation strict mode + duplicate / missing / foreign
//     id rejection
//   - Task PATCH bucketId: string moves, null unbuckets, cross-project 400,
//     cross-team 404
//   - DELETE preserves tasks (bucketId set to null, task survives)
//   - RBAC: member without buckets.manage gets 403 on writes; reads still 200

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
  await prisma.activity.deleteMany();
  await prisma.task.deleteMany();
  await prisma.bucket.deleteMany();
  await prisma.project.deleteMany();
  await prisma.rolePermission.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.role.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
});

const PASSWORD = 'CorrectHorseBattery9';

async function register(email: string) {
  return bootstrapUser(app, { email, name: email.split('@')[0], password: PASSWORD });
}

async function createTeam(token: string, slug: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/teams',
    headers: { authorization: `Bearer ${token}` },
    payload: { name: slug, slug },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

async function createProject(token: string, teamId: string, name = 'P'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/teams/${teamId}/projects`,
    headers: { authorization: `Bearer ${token}` },
    payload: { name },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

async function createTask(
  token: string,
  teamId: string,
  projectId: string,
  title: string,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/teams/${teamId}/projects/${projectId}/tasks`,
    headers: { authorization: `Bearer ${token}` },
    payload: { title },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

async function addMember(
  managerToken: string,
  teamId: string,
  email: string,
  role: 'MEMBER' | 'MANAGER' = 'MEMBER',
): Promise<void> {
  await app.inject({
    method: 'POST',
    url: `/api/teams/${teamId}/members`,
    headers: { authorization: `Bearer ${managerToken}` },
    payload: { email, role },
  });
}

function createBucket(token: string, teamId: string, projectId: string, name: string) {
  return app.inject({
    method: 'POST',
    url: `/api/teams/${teamId}/projects/${projectId}/buckets`,
    headers: { authorization: `Bearer ${token}` },
    payload: { name },
  });
}

function listBuckets(token: string, teamId: string, projectId: string) {
  return app.inject({
    method: 'GET',
    url: `/api/teams/${teamId}/projects/${projectId}/buckets`,
    headers: { authorization: `Bearer ${token}` },
  });
}

function renameBucket(token: string, teamId: string, bucketId: string, name: string) {
  return app.inject({
    method: 'PATCH',
    url: `/api/teams/${teamId}/buckets/${bucketId}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { name },
  });
}

function reorderBuckets(token: string, teamId: string, projectId: string, ids: string[]) {
  return app.inject({
    method: 'PATCH',
    url: `/api/teams/${teamId}/projects/${projectId}/buckets/reorder`,
    headers: { authorization: `Bearer ${token}` },
    payload: { bucketIds: ids },
  });
}

function deleteBucket(token: string, teamId: string, bucketId: string) {
  return app.inject({
    method: 'DELETE',
    url: `/api/teams/${teamId}/buckets/${bucketId}`,
    headers: { authorization: `Bearer ${token}` },
  });
}

function patchTask(
  token: string,
  teamId: string,
  projectId: string,
  taskId: string,
  body: Record<string, unknown>,
) {
  return app.inject({
    method: 'PATCH',
    url: `/api/teams/${teamId}/projects/${projectId}/tasks/${taskId}`,
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });
}

describe('Buckets — CRUD', () => {
  it('creates buckets with monotonic order; list returns them sorted', async () => {
    const me = await register('me@example.com');
    const teamId = await createTeam(me.token, 'team-1');
    const projectId = await createProject(me.token, teamId);

    const a = await createBucket(me.token, teamId, projectId, 'To do');
    expect(a.statusCode).toBe(201);
    expect(a.json().order).toBe(0);

    const b = await createBucket(me.token, teamId, projectId, 'Doing');
    expect(b.statusCode).toBe(201);
    expect(b.json().order).toBe(1);

    const list = await listBuckets(me.token, teamId, projectId);
    expect(list.statusCode).toBe(200);
    const names = (list.json() as Array<{ name: string; order: number }>).map((x) => x.name);
    expect(names).toEqual(['To do', 'Doing']);
  });

  it('rejects empty or oversize name with 400 (Zod)', async () => {
    const me = await register('me@example.com');
    const teamId = await createTeam(me.token, 'team-1');
    const projectId = await createProject(me.token, teamId);

    const empty = await createBucket(me.token, teamId, projectId, '');
    expect(empty.statusCode).toBe(400);
    const big = await createBucket(me.token, teamId, projectId, 'x'.repeat(81));
    expect(big.statusCode).toBe(400);
  });

  it('rename: 200 + updatedAt advances; 404 on cross-tenant bucketId', async () => {
    const me = await register('me@example.com');
    const teamId = await createTeam(me.token, 'team-1');
    const projectId = await createProject(me.token, teamId);
    const created = (await createBucket(me.token, teamId, projectId, 'To do')).json() as {
      id: string;
      updatedAt: string;
    };

    await new Promise((r) => setTimeout(r, 5)); // ensure updatedAt advances
    const renamed = await renameBucket(me.token, teamId, created.id, 'Backlog');
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().name).toBe('Backlog');
    expect(new Date(renamed.json().updatedAt).getTime()).toBeGreaterThan(
      new Date(created.updatedAt).getTime(),
    );

    // Foreigner: different team owner can't see this bucket.
    const stranger = await register('stranger@example.com');
    const teamB = await createTeam(stranger.token, 'team-stranger');
    const cross = await renameBucket(stranger.token, teamB, created.id, 'Hijack');
    expect(cross.statusCode).toBe(404);
  });
});

describe('Buckets — cross-team scoping', () => {
  it('create against another teams project → 404', async () => {
    const owner = await register('owner@example.com');
    const teamA = await createTeam(owner.token, 'team-a');
    const projA = await createProject(owner.token, teamA);

    const stranger = await register('stranger@example.com');
    const teamB = await createTeam(stranger.token, 'team-b');

    // Stranger asks to create a bucket in teamA's project via teamB URL —
    // the project doesn't live in teamB, so 404 (never 403, never 400).
    const res = await createBucket(stranger.token, teamB, projA, 'B');
    expect(res.statusCode).toBe(404);
  });

  it('non-member of either team → 403 at requireTeamRole', async () => {
    const owner = await register('owner@example.com');
    const teamId = await createTeam(owner.token, 'team-a');
    const projectId = await createProject(owner.token, teamId);

    const stranger = await register('stranger@example.com');
    const res = await createBucket(stranger.token, teamId, projectId, 'B');
    expect(res.statusCode).toBe(403);
  });
});

describe('Buckets — reorder (full-permutation)', () => {
  async function setup() {
    const me = await register('me@example.com');
    const teamId = await createTeam(me.token, 'team-1');
    const projectId = await createProject(me.token, teamId);
    const a = (await createBucket(me.token, teamId, projectId, 'A')).json().id;
    const b = (await createBucket(me.token, teamId, projectId, 'B')).json().id;
    const c = (await createBucket(me.token, teamId, projectId, 'C')).json().id;
    return { token: me.token, teamId, projectId, a, b, c };
  }

  it('happy path: order matches the requested permutation', async () => {
    const { token, teamId, projectId, a, b, c } = await setup();
    const res = await reorderBuckets(token, teamId, projectId, [c, a, b]);
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<{ id: string; order: number }>;
    const byId = new Map(items.map((i) => [i.id, i.order]));
    expect(byId.get(c)).toBe(0);
    expect(byId.get(a)).toBe(1);
    expect(byId.get(b)).toBe(2);

    // No duplicate order values left in the project.
    const groups = await prisma.bucket.groupBy({
      by: ['order'],
      where: { projectId },
      _count: { _all: true },
    });
    for (const g of groups) expect(g._count._all).toBe(1);
  });

  it('missing id → 400', async () => {
    const { token, teamId, projectId, a, b } = await setup();
    const res = await reorderBuckets(token, teamId, projectId, [a, b]);
    expect(res.statusCode).toBe(400);
  });

  it('duplicate id → 400', async () => {
    const { token, teamId, projectId, a, b, c } = await setup();
    const res = await reorderBuckets(token, teamId, projectId, [a, a, b, c]);
    expect(res.statusCode).toBe(400);
  });

  it('id from another project → 400', async () => {
    const { token, teamId, projectId, a, b, c } = await setup();
    const proj2 = await createProject(token, teamId, 'P2');
    const foreign = (await createBucket(token, teamId, proj2, 'X')).json().id;

    const res = await reorderBuckets(token, teamId, projectId, [a, b, c, foreign]);
    expect(res.statusCode).toBe(400);
  });
});

describe('Buckets — delete preserves tasks', () => {
  it('deleting a bucket nulls Task.bucketId; the task survives', async () => {
    const me = await register('me@example.com');
    const teamId = await createTeam(me.token, 'team-1');
    const projectId = await createProject(me.token, teamId);
    const bucketId = (await createBucket(me.token, teamId, projectId, 'To do')).json().id;
    const taskId = await createTask(me.token, teamId, projectId, 'a task');

    const moved = await patchTask(me.token, teamId, projectId, taskId, { bucketId });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().bucketId).toBe(bucketId);

    const del = await deleteBucket(me.token, teamId, bucketId);
    expect(del.statusCode).toBe(204);

    // Task still exists; bucketId now null.
    const after = await prisma.task.findUnique({
      where: { id: taskId },
      select: { id: true, bucketId: true },
    });
    expect(after).toBeTruthy();
    expect(after?.bucketId).toBeNull();
  });

  it('cross-tenant DELETE → 404', async () => {
    const owner = await register('owner@example.com');
    const teamA = await createTeam(owner.token, 'team-a');
    const projA = await createProject(owner.token, teamA);
    const bucketId = (await createBucket(owner.token, teamA, projA, 'X')).json().id;

    const stranger = await register('stranger@example.com');
    const teamB = await createTeam(stranger.token, 'team-b');
    const res = await deleteBucket(stranger.token, teamB, bucketId);
    expect(res.statusCode).toBe(404);
  });
});

describe('Task CREATE bucketId integration (v1.34.3)', () => {
  it('creates a task pre-bucketed when a valid bucketId is supplied', async () => {
    const me = await register('me@example.com');
    const teamId = await createTeam(me.token, 'team-1');
    const projectId = await createProject(me.token, teamId);
    const bucketId = (await createBucket(me.token, teamId, projectId, 'B')).json().id as string;

    const res = await app.inject({
      method: 'POST',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks`,
      headers: { authorization: `Bearer ${me.token}` },
      payload: { title: 'pre-bucketed', bucketId },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().bucketId).toBe(bucketId);
  });

  it('cross-project bucketId on create → 400', async () => {
    const me = await register('me@example.com');
    const teamId = await createTeam(me.token, 'team-1');
    const projectA = await createProject(me.token, teamId, 'A');
    const projectB = await createProject(me.token, teamId, 'B');
    const bucketB = (await createBucket(me.token, teamId, projectB, 'B')).json().id as string;

    const res = await app.inject({
      method: 'POST',
      url: `/api/teams/${teamId}/projects/${projectA}/tasks`,
      headers: { authorization: `Bearer ${me.token}` },
      payload: { title: 'mismatch', bucketId: bucketB },
    });
    expect(res.statusCode).toBe(400);
  });

  it('cross-team bucketId on create → 404', async () => {
    const owner = await register('owner@example.com');
    const teamA = await createTeam(owner.token, 'team-a');
    const projA = await createProject(owner.token, teamA);

    const stranger = await register('stranger@example.com');
    const teamB = await createTeam(stranger.token, 'team-b');
    const projB = await createProject(stranger.token, teamB);
    const bucketB = (await createBucket(stranger.token, teamB, projB, 'B')).json().id as string;

    const res = await app.inject({
      method: 'POST',
      url: `/api/teams/${teamA}/projects/${projA}/tasks`,
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { title: 'stolen bucket', bucketId: bucketB },
    });
    expect(res.statusCode).toBe(404);
  });

  it('omitted bucketId on create → unbucketed (null)', async () => {
    const me = await register('me@example.com');
    const teamId = await createTeam(me.token, 'team-1');
    const projectId = await createProject(me.token, teamId);

    const res = await app.inject({
      method: 'POST',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks`,
      headers: { authorization: `Bearer ${me.token}` },
      payload: { title: 'naked' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().bucketId).toBeNull();
  });
});

describe('Task PATCH bucketId integration', () => {
  it('string moves the task; null unbuckets it', async () => {
    const me = await register('me@example.com');
    const teamId = await createTeam(me.token, 'team-1');
    const projectId = await createProject(me.token, teamId);
    const taskId = await createTask(me.token, teamId, projectId, 'T');
    const bucketId = (await createBucket(me.token, teamId, projectId, 'B')).json().id;

    const move = await patchTask(me.token, teamId, projectId, taskId, { bucketId });
    expect(move.statusCode).toBe(200);
    expect(move.json().bucketId).toBe(bucketId);

    const unbucket = await patchTask(me.token, teamId, projectId, taskId, { bucketId: null });
    expect(unbucket.statusCode).toBe(200);
    expect(unbucket.json().bucketId).toBeNull();
  });

  it('cross-project bucketId → 400', async () => {
    const me = await register('me@example.com');
    const teamId = await createTeam(me.token, 'team-1');
    const projectA = await createProject(me.token, teamId, 'A');
    const projectB = await createProject(me.token, teamId, 'B');
    const taskId = await createTask(me.token, teamId, projectA, 'T');
    const bucketB = (await createBucket(me.token, teamId, projectB, 'B')).json().id;

    const res = await patchTask(me.token, teamId, projectA, taskId, { bucketId: bucketB });
    expect(res.statusCode).toBe(400);
  });

  it('cross-team bucketId → 404 (never 400 — leaks existence)', async () => {
    const owner = await register('owner@example.com');
    const teamA = await createTeam(owner.token, 'team-a');
    const projA = await createProject(owner.token, teamA);
    const taskA = await createTask(owner.token, teamA, projA, 'T');

    const stranger = await register('stranger@example.com');
    const teamB = await createTeam(stranger.token, 'team-b');
    const projB = await createProject(stranger.token, teamB);
    const bucketB = (await createBucket(stranger.token, teamB, projB, 'B')).json().id;

    const res = await patchTask(owner.token, teamA, projA, taskA, { bucketId: bucketB });
    expect(res.statusCode).toBe(404);
  });
});

describe('Buckets — RBAC (buckets.manage)', () => {
  // teamsService.create makes the team + memberships but leaves
  // TeamMembership.roleId = null (system Role rows are created lazily by
  // the directory/JIT paths). We bind a real custom Role here so the
  // permission check goes through the role-id path instead of the legacy
  // DEFAULT_*_PERMISSIONS fallback — which is what makes "revoked
  // buckets.manage" testable at all.
  async function bindCustomRole(opts: {
    teamId: string;
    userId: string;
    name: string;
    permissions: readonly string[];
  }): Promise<void> {
    const role = await prisma.role.create({
      data: {
        teamId: opts.teamId,
        name: opts.name,
        description: 'test',
        isSystem: false,
        permissions: { create: opts.permissions.map((p) => ({ permission: p })) },
      },
    });
    await prisma.teamMembership.update({
      where: { userId_teamId: { userId: opts.userId, teamId: opts.teamId } },
      data: { roleId: role.id },
    });
  }

  it('member without buckets.manage gets 403 on writes; read still 200', async () => {
    const admin = await register('admin@example.com');
    const teamId = await createTeam(admin.token, 'team-1');
    const plain = await register('plain@example.com');
    await addMember(admin.token, teamId, plain.email, 'MEMBER');
    // v1.39: project owned by `plain` so the visibility-gate cascade lets
    // them reach the buckets routes — we want a 403 from the permission
    // check, not a 404 from the gate.
    const projectId = await createProject(plain.token, teamId);
    // Seed: pre-existing bucket so reads have something to return. Admin
    // can still create buckets in plain's project (global-ADMIN bypass).
    const bucketId = (await createBucket(admin.token, teamId, projectId, 'pre-existing')).json()
      .id as string;

    // Bind plain to a custom role that has EVERYTHING ELSE except
    // buckets.manage. The test asserts writes are denied; reads pass.
    await bindCustomRole({
      teamId,
      userId: plain.userId,
      name: 'NoBucketEdit',
      permissions: ['task.delete', 'task.modify_dates'],
    });

    // Read: still allowed (no permission gate on GET).
    const read = await listBuckets(plain.token, teamId, projectId);
    expect(read.statusCode).toBe(200);

    // Create: 403.
    const create = await createBucket(plain.token, teamId, projectId, 'X');
    expect(create.statusCode).toBe(403);

    // Rename: 403.
    const rename = await renameBucket(plain.token, teamId, bucketId, 'X');
    expect(rename.statusCode).toBe(403);

    // Reorder: 403.
    const reorder = await reorderBuckets(plain.token, teamId, projectId, [bucketId]);
    expect(reorder.statusCode).toBe(403);

    // Delete: 403.
    const del = await deleteBucket(plain.token, teamId, bucketId);
    expect(del.statusCode).toBe(403);
  });

  it('global ADMIN bypasses buckets.manage even when revoked on their team role', async () => {
    const admin = await register('admin@example.com');
    const teamId = await createTeam(admin.token, 'team-1');
    const projectId = await createProject(admin.token, teamId);

    // Strip buckets.manage from the admin's team role explicitly. The
    // global-ADMIN bypass in hasPermission() should still let this pass.
    await bindCustomRole({
      teamId,
      userId: admin.userId,
      name: 'NoBucketEdit',
      permissions: ['task.delete', 'task.modify_dates'],
    });

    const res = await createBucket(admin.token, teamId, projectId, 'X');
    expect(res.statusCode).toBe(201);
  });
});

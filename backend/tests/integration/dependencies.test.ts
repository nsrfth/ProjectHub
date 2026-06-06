import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';

// v1.29: task dependency edges.
//
// Covers:
//   - self-loop rejection (400)
//   - cross-team rejection (404 — opaque to the caller)
//   - cross-project rejection within a team (400)
//   - cycle detection (409 DEPENDENCY_CYCLE)
//   - duplicate edge (409 CONFLICT)
//   - status guard in "block" mode (403 DEPENDENCY_BLOCKED on IN_PROGRESS/DONE)
//   - status guard NOT enforced in "off" / "warn"
//   - unblock notification fan-out when a blocker completes
//   - ON DELETE cascade when either endpoint task is hard-deleted
//   - permission gate: member without task.manage_dependencies → 403
//   - admin can list dependencies; admin bypasses the permission gate on write

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
  await prisma.notification.deleteMany();
  await prisma.taskDependency.deleteMany();
  await prisma.task.deleteMany();
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

async function register(email: string, name = 'User'): Promise<{ token: string; userId: string }> {
  const r = await bootstrapUser(app, { email, name, password: PASSWORD });
  return { token: r.token, userId: r.userId };
}

async function createTeam(token: string, slug: string): Promise<string> {
  // slug min length 3 per the team schema.
  const fullSlug = slug.length < 3 ? `dep-team-${slug}` : slug;
  const r = await app.inject({
    method: 'POST',
    url: '/api/teams',
    headers: { authorization: `Bearer ${token}` },
    payload: { name: fullSlug, slug: fullSlug },
  });
  if (r.statusCode !== 201) throw new Error(`createTeam failed: ${r.statusCode} ${r.body}`);
  return r.json().id as string;
}

async function createProject(token: string, teamId: string, name: string): Promise<string> {
  const r = await app.inject({
    method: 'POST',
    url: `/api/teams/${teamId}/projects`,
    headers: { authorization: `Bearer ${token}` },
    payload: { name },
  });
  if (r.statusCode !== 201) throw new Error(`createProject failed: ${r.statusCode} ${r.body}`);
  return r.json().id as string;
}

async function createTask(
  token: string,
  teamId: string,
  projectId: string,
  title: string,
): Promise<string> {
  const r = await app.inject({
    method: 'POST',
    url: `/api/teams/${teamId}/projects/${projectId}/tasks`,
    headers: { authorization: `Bearer ${token}` },
    payload: { title },
  });
  if (r.statusCode !== 201) {
    throw new Error(`createTask failed: ${r.statusCode} ${r.body}`);
  }
  return r.json().id as string;
}

async function addEdge(
  token: string,
  teamId: string,
  projectId: string,
  taskId: string,
  dependsOnId: string,
): Promise<ReturnType<typeof app.inject> extends Promise<infer R> ? R : never> {
  return app.inject({
    method: 'POST',
    url: `/api/teams/${teamId}/projects/${projectId}/tasks/${taskId}/dependencies`,
    headers: { authorization: `Bearer ${token}` },
    payload: { dependsOnId },
  });
}

async function setEnforcement(value: 'off' | 'warn' | 'block', userId: string): Promise<void> {
  await prisma.instanceSetting.upsert({
    where: { key: 'tasks.dependencyEnforcement' },
    update: { value: value as never, updatedBy: userId },
    create: { key: 'tasks.dependencyEnforcement', value: value as never, updatedBy: userId },
  });
}

// First-registered user is global ADMIN. Subsequent registrations are
// MEMBER + global, but creating a team makes them MANAGER of that team —
// which carries `task.manage_dependencies` via the migration backfill.
describe('Task dependencies', () => {
  it('rejects a self-dependency with 400', async () => {
    const { token } = await register('a@example.com');
    const teamId = await createTeam(token, 'a-team');
    const projectId = await createProject(token, teamId, 'P');
    const t = await createTask(token, teamId, projectId, 'X');
    const res = await addEdge(token, teamId, projectId, t, t);
    expect(res.statusCode).toBe(400);
  });

  it('rejects a cross-team dependency target with 404 (opaque)', async () => {
    const a = await register('a@example.com');
    const b = await register('b@example.com');
    const teamA = await createTeam(a.token, 'team-a');
    const teamB = await createTeam(b.token, 'team-b');
    const projA = await createProject(a.token, teamA, 'PA');
    const projB = await createProject(b.token, teamB, 'PB');
    const taskA = await createTask(a.token, teamA, projA, 'A');
    const taskB = await createTask(b.token, teamB, projB, 'B');
    // User A tries to make their task depend on team B's task.
    const res = await addEdge(a.token, teamA, projA, taskA, taskB);
    // We surface "not found" rather than 403 so the existence of B is opaque.
    expect(res.statusCode).toBe(404);
  });

  it('rejects a cross-project dependency within the same team with 400', async () => {
    const { token } = await register('a@example.com');
    const teamId = await createTeam(token, 'a');
    const projA = await createProject(token, teamId, 'PA');
    const projB = await createProject(token, teamId, 'PB');
    const tA = await createTask(token, teamId, projA, 'A');
    const tB = await createTask(token, teamId, projB, 'B');
    const res = await addEdge(token, teamId, projA, tA, tB);
    expect(res.statusCode).toBe(400);
  });

  it('rejects a dependency that would create a cycle with 409 DEPENDENCY_CYCLE', async () => {
    const { token } = await register('a@example.com');
    const teamId = await createTeam(token, 'a');
    const projectId = await createProject(token, teamId, 'P');
    const t1 = await createTask(token, teamId, projectId, 'T1');
    const t2 = await createTask(token, teamId, projectId, 'T2');
    const t3 = await createTask(token, teamId, projectId, 'T3');

    // t2 depends on t1; t3 depends on t2. Chain: t1 ← t2 ← t3.
    expect((await addEdge(token, teamId, projectId, t2, t1)).statusCode).toBe(201);
    expect((await addEdge(token, teamId, projectId, t3, t2)).statusCode).toBe(201);

    // Adding t1 → t3 would close the cycle (t1 ← t2 ← t3 ← t1).
    const cycle = await addEdge(token, teamId, projectId, t1, t3);
    expect(cycle.statusCode).toBe(409);
    expect(cycle.json().error.code).toBe('DEPENDENCY_CYCLE');
  });

  it('rejects a duplicate edge with 409 CONFLICT', async () => {
    const { token } = await register('a@example.com');
    const teamId = await createTeam(token, 'a');
    const projectId = await createProject(token, teamId, 'P');
    const t1 = await createTask(token, teamId, projectId, 'T1');
    const t2 = await createTask(token, teamId, projectId, 'T2');
    const first = await addEdge(token, teamId, projectId, t2, t1);
    if (first.statusCode !== 201) throw new Error(`unexpected: ${first.statusCode} ${first.body}`);
    const dup = await addEdge(token, teamId, projectId, t2, t1);
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('CONFLICT');
  });

  it('GET returns both directions joined with task titles + statuses', async () => {
    const { token } = await register('a@example.com');
    const teamId = await createTeam(token, 'a');
    const projectId = await createProject(token, teamId, 'P');
    const t1 = await createTask(token, teamId, projectId, 'Blocker');
    const t2 = await createTask(token, teamId, projectId, 'Middle');
    const t3 = await createTask(token, teamId, projectId, 'Top');
    expect((await addEdge(token, teamId, projectId, t2, t1)).statusCode).toBe(201);
    expect((await addEdge(token, teamId, projectId, t3, t2)).statusCode).toBe(201);

    // From the middle task's perspective: one blocker (t1), one dependent (t3).
    const res = await app.inject({
      method: 'GET',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks/${t2}/dependencies`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.blockedBy).toHaveLength(1);
    expect(body.blockedBy[0].task.id).toBe(t1);
    expect(body.blockedBy[0].task.title).toBe('Blocker');
    expect(body.blocking).toHaveLength(1);
    expect(body.blocking[0].task.id).toBe(t3);
    expect(body.enforcement).toBe('off');
  });

  it('status guard in "block" mode rejects IN_PROGRESS/DONE while a blocker is incomplete', async () => {
    const { token, userId } = await register('a@example.com');
    const teamId = await createTeam(token, 'a');
    const projectId = await createProject(token, teamId, 'P');
    const blocker = await createTask(token, teamId, projectId, 'Blocker');
    const blocked = await createTask(token, teamId, projectId, 'Blocked');
    expect((await addEdge(token, teamId, projectId, blocked, blocker)).statusCode).toBe(201);
    await setEnforcement('block', userId);

    const inProg = await app.inject({
      method: 'PATCH',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks/${blocked}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { status: 'IN_PROGRESS' },
    });
    expect(inProg.statusCode).toBe(403);
    expect(inProg.json().error.code).toBe('DEPENDENCY_BLOCKED');

    // Completing the blocker unblocks the dependent.
    const finishBlocker = await app.inject({
      method: 'PATCH',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks/${blocker}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { status: 'DONE' },
    });
    expect(finishBlocker.statusCode).toBe(200);

    const inProg2 = await app.inject({
      method: 'PATCH',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks/${blocked}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { status: 'IN_PROGRESS' },
    });
    expect(inProg2.statusCode).toBe(200);
  });

  it('status guard in "warn" / "off" mode never blocks the transition', async () => {
    const { token, userId } = await register('a@example.com');
    const teamId = await createTeam(token, 'a');
    const projectId = await createProject(token, teamId, 'P');
    const blocker = await createTask(token, teamId, projectId, 'Blocker');
    const blocked = await createTask(token, teamId, projectId, 'Blocked');
    expect((await addEdge(token, teamId, projectId, blocked, blocker)).statusCode).toBe(201);

    await setEnforcement('warn', userId);
    let res = await app.inject({
      method: 'PATCH',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks/${blocked}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { status: 'IN_PROGRESS' },
    });
    expect(res.statusCode).toBe(200);

    // Reset to TODO + flip to "off". Still allowed.
    await app.inject({
      method: 'PATCH',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks/${blocked}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { status: 'TODO' },
    });
    await setEnforcement('off', userId);
    res = await app.inject({
      method: 'PATCH',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks/${blocked}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { status: 'DONE' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('completing the only blocker writes a TASK_UNBLOCKED notification to the dependent', async () => {
    // Creator-of-task automatically becomes the technician (v1.19). The
    // unblock fan-out targets assignee + technician; we set both to
    // user B and have user A complete the blocker so A != recipient.
    const a = await register('a@example.com');
    const b = await register('b@example.com', 'B');
    const teamId = await createTeam(a.token, 'a');
    // Invite B as a team member.
    // roleId left null → requirePermission falls back to the legacy enum
    // mapping (DEFAULT_MEMBER_PERMISSIONS), which does NOT include
    // task.manage_dependencies, so a MEMBER user is correctly gated out.
    await prisma.teamMembership.create({
      data: { userId: b.userId, teamId, role: 'MEMBER' },
    });
    const projectId = await createProject(a.token, teamId, 'P');
    const blocker = await createTask(a.token, teamId, projectId, 'Blocker');
    const blocked = await createTask(a.token, teamId, projectId, 'Blocked');
    // Reassign blocked to B (both assignee + technician — but A is the
    // creator so technician was A; flip both).
    await app.inject({
      method: 'PATCH',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks/${blocked}`,
      headers: { authorization: `Bearer ${a.token}` },
      payload: { assigneeId: b.userId, technicianId: b.userId },
    });
    expect((await addEdge(a.token, teamId, projectId, blocked, blocker)).statusCode).toBe(201);

    // A completes the blocker. B should now have a TASK_UNBLOCKED row.
    const done = await app.inject({
      method: 'PATCH',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks/${blocker}`,
      headers: { authorization: `Bearer ${a.token}` },
      payload: { status: 'DONE' },
    });
    expect(done.statusCode).toBe(200);

    const unblock = await prisma.notification.findFirst({
      where: { userId: b.userId, type: 'TASK_UNBLOCKED' },
    });
    expect(unblock).not.toBeNull();
    expect((unblock!.payload as { taskId: string }).taskId).toBe(blocked);
  });

  it('completing one blocker does NOT notify when others remain incomplete', async () => {
    const a = await register('a@example.com');
    const b = await register('b@example.com', 'B');
    const teamId = await createTeam(a.token, 'a');
    // roleId left null → requirePermission falls back to the legacy enum
    // mapping (DEFAULT_MEMBER_PERMISSIONS), which does NOT include
    // task.manage_dependencies, so a MEMBER user is correctly gated out.
    await prisma.teamMembership.create({
      data: { userId: b.userId, teamId, role: 'MEMBER' },
    });
    const projectId = await createProject(a.token, teamId, 'P');
    const blocker1 = await createTask(a.token, teamId, projectId, 'B1');
    const blocker2 = await createTask(a.token, teamId, projectId, 'B2');
    const blocked = await createTask(a.token, teamId, projectId, 'Top');
    await app.inject({
      method: 'PATCH',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks/${blocked}`,
      headers: { authorization: `Bearer ${a.token}` },
      payload: { assigneeId: b.userId, technicianId: b.userId },
    });
    expect((await addEdge(a.token, teamId, projectId, blocked, blocker1)).statusCode).toBe(201);
    expect((await addEdge(a.token, teamId, projectId, blocked, blocker2)).statusCode).toBe(201);

    // Complete one of two blockers.
    await app.inject({
      method: 'PATCH',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks/${blocker1}`,
      headers: { authorization: `Bearer ${a.token}` },
      payload: { status: 'DONE' },
    });
    const unblockBefore = await prisma.notification.findFirst({
      where: { userId: b.userId, type: 'TASK_UNBLOCKED' },
    });
    expect(unblockBefore).toBeNull();

    // Complete the second blocker — now fully unblocked.
    await app.inject({
      method: 'PATCH',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks/${blocker2}`,
      headers: { authorization: `Bearer ${a.token}` },
      payload: { status: 'DONE' },
    });
    const unblockAfter = await prisma.notification.findFirst({
      where: { userId: b.userId, type: 'TASK_UNBLOCKED' },
    });
    expect(unblockAfter).not.toBeNull();
  });

  it('hard-deleting a task cascades the edges it participates in', async () => {
    const { token } = await register('a@example.com');
    const teamId = await createTeam(token, 'a');
    const projectId = await createProject(token, teamId, 'P');
    const t1 = await createTask(token, teamId, projectId, 'T1');
    const t2 = await createTask(token, teamId, projectId, 'T2');
    expect((await addEdge(token, teamId, projectId, t2, t1)).statusCode).toBe(201);

    // Hard-delete t1 directly via Prisma (DELETE /tasks/:id soft-deletes; we
    // want to verify the FK CASCADE on actual row removal).
    await prisma.task.delete({ where: { id: t1 } });
    const remaining = await prisma.taskDependency.count({});
    expect(remaining).toBe(0);
  });

  it('DELETE /dependencies/:id removes the edge + 404 for unknown id', async () => {
    const { token } = await register('a@example.com');
    const teamId = await createTeam(token, 'a');
    const projectId = await createProject(token, teamId, 'P');
    const t1 = await createTask(token, teamId, projectId, 'T1');
    const t2 = await createTask(token, teamId, projectId, 'T2');
    const created = await addEdge(token, teamId, projectId, t2, t1);
    expect(created.statusCode).toBe(201);
    const edgeId = created.json().id as string;

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks/${t2}/dependencies/${edgeId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del.statusCode).toBe(204);

    const missing = await app.inject({
      method: 'DELETE',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks/${t2}/dependencies/does-not-exist`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('member without task.manage_dependencies cannot add an edge (403)', async () => {
    // First-registered user is global ADMIN; second is MEMBER + becomes
    // MANAGER of a team they create. To force the permission gate we
    // create a team owned by user A and add user B as a plain MEMBER.
    const a = await register('admin@example.com');
    const b = await register('member@example.com', 'B');
    const teamId = await createTeam(a.token, 'a');
    // roleId left null → requirePermission falls back to the legacy enum
    // mapping (DEFAULT_MEMBER_PERMISSIONS), which does NOT include
    // task.manage_dependencies, so a MEMBER user is correctly gated out.
    await prisma.teamMembership.create({
      data: { userId: b.userId, teamId, role: 'MEMBER' },
    });
    const projectId = await createProject(a.token, teamId, 'P');
    const t1 = await createTask(a.token, teamId, projectId, 'T1');
    const t2 = await createTask(a.token, teamId, projectId, 'T2');

    const res = await app.inject({
      method: 'POST',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks/${t2}/dependencies`,
      headers: { authorization: `Bearer ${b.token}` },
      payload: { dependsOnId: t1 },
    });
    expect(res.statusCode).toBe(403);
  });
});

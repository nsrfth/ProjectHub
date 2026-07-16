import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';

// v1.83: SS + FF dependency types with per-type status-rule enforcement.

let app: FastifyInstance;

beforeAll(async () => {
  process.env.MASTER_KEY ??= '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
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
const H = (token: string) => ({ authorization: `Bearer ${token}` });

async function register(email: string) {
  const r = await bootstrapUser(app, { email, name: email.split('@')[0], password: PASSWORD });
  return { token: r.token, userId: r.userId };
}
async function createTeam(token: string, slug: string): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/api/teams', headers: H(token), payload: { name: slug, slug } });
  if (r.statusCode !== 201) throw new Error(`createTeam ${r.statusCode} ${r.body}`);
  return r.json().id as string;
}
async function createProject(token: string, teamId: string, name = 'P'): Promise<string> {
  const r = await app.inject({ method: 'POST', url: `/api/teams/${teamId}/projects`, headers: H(token), payload: { name } });
  if (r.statusCode !== 201) throw new Error(`createProject ${r.statusCode} ${r.body}`);
  return r.json().id as string;
}
async function createTask(token: string, teamId: string, projectId: string, title: string): Promise<string> {
  const r = await app.inject({ method: 'POST', url: `/api/teams/${teamId}/projects/${projectId}/tasks`, headers: H(token), payload: { title } });
  if (r.statusCode !== 201) throw new Error(`createTask ${r.statusCode} ${r.body}`);
  return r.json().id as string;
}
function addEdge(token: string, teamId: string, projectId: string, taskId: string, dependsOnId: string, type: string) {
  return app.inject({ method: 'POST', url: `/api/teams/${teamId}/projects/${projectId}/tasks/${taskId}/dependencies`, headers: H(token), payload: { dependsOnId, type } });
}
function listDeps(token: string, teamId: string, projectId: string, taskId: string) {
  return app.inject({ method: 'GET', url: `/api/teams/${teamId}/projects/${projectId}/tasks/${taskId}/dependencies`, headers: H(token) });
}
function setStatus(token: string, teamId: string, projectId: string, taskId: string, status: string) {
  // v2.5.58: transitions into DONE require a statusComment. Harmless on the
  // 403 DEPENDENCY_BLOCKED assertions too — the dependency guard runs first.
  const payload = status === 'DONE' ? { status, statusComment: 'done (test)' } : { status };
  return app.inject({ method: 'PATCH', url: `/api/teams/${teamId}/projects/${projectId}/tasks/${taskId}`, headers: H(token), payload });
}
async function setEnforcement(value: 'off' | 'warn' | 'block', userId: string): Promise<void> {
  await prisma.instanceSetting.upsert({
    where: { key: 'tasks.dependencyEnforcement' },
    update: { value: value as never, updatedBy: userId },
    create: { key: 'tasks.dependencyEnforcement', value: value as never, updatedBy: userId },
  });
}

// Setup a team/project with two tasks A (the predecessor) and B (depends on A).
async function setup(type: string) {
  const admin = await register('admin@x.com'); // first user → ADMIN (bypasses gates)
  const teamId = await createTeam(admin.token, 'team-a');
  const projectId = await createProject(admin.token, teamId);
  const a = await createTask(admin.token, teamId, projectId, 'A');
  const b = await createTask(admin.token, teamId, projectId, 'B');
  const edge = await addEdge(admin.token, teamId, projectId, b, a, type);
  if (edge.statusCode !== 201) throw new Error(`addEdge ${edge.statusCode} ${edge.body}`);
  return { token: admin.token, userId: admin.userId, teamId, projectId, a, b, edge };
}

describe('dependency types SS / FF enforcement', () => {
  it('FS (existing) blocks IN_PROGRESS and DONE until A is DONE (block mode)', async () => {
    const s = await setup('FINISH_TO_START');
    await setEnforcement('block', s.userId);
    expect((await setStatus(s.token, s.teamId, s.projectId, s.b, 'IN_PROGRESS')).statusCode).toBe(403);
    expect((await setStatus(s.token, s.teamId, s.projectId, s.b, 'DONE')).statusCode).toBe(403);
    await setStatus(s.token, s.teamId, s.projectId, s.a, 'DONE');
    expect((await setStatus(s.token, s.teamId, s.projectId, s.b, 'IN_PROGRESS')).statusCode).toBe(200);
  });

  it('SS blocks IN_PROGRESS while A is TODO; allows it once A has started', async () => {
    const s = await setup('START_TO_START');
    await setEnforcement('block', s.userId);
    expect((await setStatus(s.token, s.teamId, s.projectId, s.b, 'IN_PROGRESS')).statusCode).toBe(403);
    await setStatus(s.token, s.teamId, s.projectId, s.a, 'IN_PROGRESS'); // A starts
    expect((await setStatus(s.token, s.teamId, s.projectId, s.b, 'IN_PROGRESS')).statusCode).toBe(200);
  });

  it('FF blocks DONE while A is not DONE but allows B to start (IN_PROGRESS)', async () => {
    const s = await setup('FINISH_TO_FINISH');
    await setEnforcement('block', s.userId);
    expect((await setStatus(s.token, s.teamId, s.projectId, s.b, 'IN_PROGRESS')).statusCode).toBe(200); // start is free
    expect((await setStatus(s.token, s.teamId, s.projectId, s.b, 'DONE')).statusCode).toBe(403); // can't finish
    await setStatus(s.token, s.teamId, s.projectId, s.a, 'DONE');
    expect((await setStatus(s.token, s.teamId, s.projectId, s.b, 'DONE')).statusCode).toBe(200);
  });

  it("enforcement 'off' and 'warn' never hard-block SS/FS", async () => {
    const s = await setup('START_TO_START');
    await setEnforcement('off', s.userId);
    expect((await setStatus(s.token, s.teamId, s.projectId, s.b, 'IN_PROGRESS')).statusCode).toBe(200);
    // reset B and switch to warn
    await setStatus(s.token, s.teamId, s.projectId, s.b, 'TODO');
    await setEnforcement('warn', s.userId);
    expect((await setStatus(s.token, s.teamId, s.projectId, s.b, 'IN_PROGRESS')).statusCode).toBe(200);
  });

  it('RELATES_TO never blocks anything (block mode)', async () => {
    const s = await setup('RELATES_TO');
    await setEnforcement('block', s.userId);
    expect((await setStatus(s.token, s.teamId, s.projectId, s.b, 'IN_PROGRESS')).statusCode).toBe(200);
    expect((await setStatus(s.token, s.teamId, s.projectId, s.b, 'DONE')).statusCode).toBe(200);
  });

  it('persists the chosen type and returns it on list', async () => {
    const s = await setup('FINISH_TO_FINISH');
    expect(s.edge.json().type).toBe('FINISH_TO_FINISH');
    const list = await listDeps(s.token, s.teamId, s.projectId, s.b);
    expect(list.statusCode).toBe(200);
    expect(list.json().blockedBy[0].type).toBe('FINISH_TO_FINISH');
  });

  it('cycle detection rejects a cycle formed via an SS edge (409)', async () => {
    const admin = await register('admin@x.com');
    const teamId = await createTeam(admin.token, 'team-a');
    const projectId = await createProject(admin.token, teamId);
    const a = await createTask(admin.token, teamId, projectId, 'A');
    const b = await createTask(admin.token, teamId, projectId, 'B');
    // A depends on B (FS), then B depends on A (SS) → would close a cycle.
    expect((await addEdge(admin.token, teamId, projectId, a, b, 'FINISH_TO_START')).statusCode).toBe(201);
    const res = await addEdge(admin.token, teamId, projectId, b, a, 'START_TO_START');
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('DEPENDENCY_CYCLE');
  });

  it('rejects a cross-team dependency target (404, opaque)', async () => {
    const admin = await register('admin@x.com');
    const teamA = await createTeam(admin.token, 'team-a');
    const pA = await createProject(admin.token, teamA);
    const a = await createTask(admin.token, teamA, pA, 'A');
    const teamB = await createTeam(admin.token, 'team-b');
    const pB = await createProject(admin.token, teamB);
    const bOther = await createTask(admin.token, teamB, pB, 'Other');
    // Try to make A (team A) depend on a task in team B → 404.
    const res = await addEdge(admin.token, teamA, pA, a, bOther, 'START_TO_START');
    expect(res.statusCode).toBe(404);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';

// v1.92 (PMIS R1 — neutral core): optional human project `code`, unique per team.

let app: FastifyInstance;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_ACCESS_SECRET ||= 'test_access_secret_at_least_32_chars_long_xx';
  process.env.JWT_REFRESH_SECRET ||= 'test_refresh_secret_at_least_32_chars_long_x';
  process.env.CORS_ORIGINS ||= 'http://localhost:5173';
  process.env.COOKIE_SECURE ||= 'false';
  app = await buildApp(loadEnv());
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await prisma.refreshToken.deleteMany();
  await prisma.task.deleteMany();
  await prisma.project.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
});

const PASSWORD = 'CorrectHorseBattery9';
function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}
async function register(email: string, globalRole: 'ADMIN' | 'MEMBER') {
  const r = await bootstrapUser(app, { email, name: email.split('@')[0], password: PASSWORD, globalRole });
  return { token: r.token, userId: r.userId };
}
async function createTeam(token: string, slug: string): Promise<{ id: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/teams', headers: auth(token), payload: { name: slug, slug } });
  if (res.statusCode !== 201) throw new Error(`createTeam ${res.statusCode} ${res.body}`);
  return res.json() as { id: string };
}
async function addMember(adminToken: string, teamId: string, email: string, role: 'MEMBER' | 'MANAGER') {
  const res = await app.inject({ method: 'POST', url: `/api/teams/${teamId}/members`, headers: auth(adminToken), payload: { email, role } });
  if (res.statusCode !== 201) throw new Error(`addMember ${res.statusCode} ${res.body}`);
}
function createProjectRaw(token: string, teamId: string, payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: `/api/teams/${teamId}/projects`, headers: auth(token), payload: { name: 'P', ...payload } });
}
async function createProject(token: string, teamId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await createProjectRaw(token, teamId, payload);
  if (res.statusCode !== 201) throw new Error(`createProject ${res.statusCode} ${res.body}`);
  return res.json() as Record<string, unknown>;
}
function patchProject(token: string, teamId: string, projectId: string, body: Record<string, unknown>) {
  return app.inject({ method: 'PATCH', url: `/api/teams/${teamId}/projects/${projectId}`, headers: auth(token), payload: body });
}
function getProject(token: string, teamId: string, projectId: string) {
  return app.inject({ method: 'GET', url: `/api/teams/${teamId}/projects/${projectId}`, headers: auth(token) });
}

describe('Project code (unique per team)', () => {
  it('creates with a code and returns it; absent code is null', async () => {
    const admin = await register('admin@x.com', 'ADMIN');
    const team = await createTeam(admin.token, 'team-a');

    const withCode = await createProject(admin.token, team.id, { code: 'EPC-014' });
    expect(withCode.code).toBe('EPC-014');
    const fetched = (await getProject(admin.token, team.id, withCode.id as string)).json();
    expect(fetched.code).toBe('EPC-014');

    const noCode = await createProject(admin.token, team.id, {});
    expect(noCode.code).toBeNull();
  });

  it('rejects a duplicate code within the same team (409)', async () => {
    const admin = await register('admin@x.com', 'ADMIN');
    const team = await createTeam(admin.token, 'team-a');
    await createProject(admin.token, team.id, { code: 'DUP-1' });

    const res = await createProjectRaw(admin.token, team.id, { code: 'DUP-1' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CONFLICT');
  });

  it('allows the same code in two different teams', async () => {
    const admin = await register('admin@x.com', 'ADMIN');
    const teamA = await createTeam(admin.token, 'team-a');
    const teamB = await createTeam(admin.token, 'team-b');
    const a = await createProject(admin.token, teamA.id, { code: 'SHARED' });
    const b = await createProject(admin.token, teamB.id, { code: 'SHARED' });
    expect(a.code).toBe('SHARED');
    expect(b.code).toBe('SHARED');
  });

  it('updates the code, rejects a clash, and clears with null', async () => {
    const admin = await register('admin@x.com', 'ADMIN');
    const team = await createTeam(admin.token, 'team-a');
    const taken = await createProject(admin.token, team.id, { code: 'TAKEN' });
    const p = await createProject(admin.token, team.id, {});

    // set a code
    const set = await patchProject(admin.token, team.id, p.id as string, { code: 'NEW-1' });
    expect(set.statusCode).toBe(200);
    expect(set.json().code).toBe('NEW-1');

    // clash with an existing code → 409
    const clash = await patchProject(admin.token, team.id, p.id as string, { code: 'TAKEN' });
    expect(clash.statusCode).toBe(409);
    void taken;

    // clear with null
    const cleared = await patchProject(admin.token, team.id, p.id as string, { code: null });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().code).toBeNull();
  });

  it('refuses a rename-only MANAGER setting a code on a project they do not own (403)', async () => {
    const admin = await register('admin@x.com', 'ADMIN');
    const mgr = await register('mgr@x.com', 'MEMBER');
    const team = await createTeam(admin.token, 'team-a');
    await addMember(admin.token, team.id, 'mgr@x.com', 'MANAGER');
    const project = await createProject(admin.token, team.id, {}); // owned by admin

    const res = await patchProject(mgr.token, team.id, project.id as string, { code: 'X-1' });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a code longer than 40 chars (400)', async () => {
    const admin = await register('admin@x.com', 'ADMIN');
    const team = await createTeam(admin.token, 'team-a');
    const res = await createProjectRaw(admin.token, team.id, { code: 'X'.repeat(41) });
    expect(res.statusCode).toBe(400);
  });
});

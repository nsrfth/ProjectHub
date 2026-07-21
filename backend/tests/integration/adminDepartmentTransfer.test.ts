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
  app = await buildApp(loadEnv());
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await prisma.refreshToken.deleteMany();
  await prisma.projectAccessGrant.deleteMany();
  await prisma.projectGroupGrant.deleteMany();
  await prisma.userGroupMember.deleteMany();
  await prisma.userGroup.deleteMany();
  await prisma.task.deleteMany();
  await prisma.project.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
});

const PASSWORD = 'CorrectHorseBattery9';
const H = (t: string) => ({ authorization: `Bearer ${t}` });

async function register(email: string): Promise<{ token: string; userId: string; role: 'ADMIN' | 'MEMBER' }> {
  const r = await bootstrapUser(app, { email, name: email.split('@')[0], password: PASSWORD });
  const user = await prisma.user.findUnique({ where: { id: r.userId } });
  return { token: r.token, userId: r.userId, role: user!.globalRole as 'ADMIN' | 'MEMBER' };
}

async function fixture() {
  const team = await prisma.team.create({ data: { name: 'Div', slug: 'div' } });
  const project = await prisma.project.create({ data: { teamId: team.id, name: 'Proj' } });
  const deptA = await prisma.userGroup.create({ data: { teamId: team.id, name: 'DeptA', kind: 'UNIT' } });
  const deptB = await prisma.userGroup.create({ data: { teamId: team.id, name: 'DeptB', kind: 'UNIT' } });
  await prisma.projectAccessGrant.create({
    data: { projectId: project.id, subjectType: 'GROUP', subjectId: deptA.id, level: 'WRITE', status: 'ACTIVE', source: 'test' },
  });
  return { team, project, deptA, deptB };
}

describe('admin project ↔ department transfer', () => {
  it('moves a project from its current department to another (ADMIN)', async () => {
    const admin = await register('admin@example.com'); // first user -> ADMIN
    const { project, deptA, deptB } = await fixture();

    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/projects/${project.id}/transfer-department`,
      headers: H(admin.token),
      payload: { toGroupId: deptB.id },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.to.id).toBe(deptB.id);
    expect(body.from?.id).toBe(deptA.id);
    expect(body.grantsMoved).toBe(1);

    const active = await prisma.projectAccessGrant.findMany({
      where: { projectId: project.id, subjectType: 'GROUP', status: 'ACTIVE' },
    });
    const ids = active.map((g) => g.subjectId);
    expect(ids).toContain(deptB.id);
    expect(ids).not.toContain(deptA.id);
  });

  it('transfers to a department in a different division (cross-team, no prior dept)', async () => {
    const admin = await register('admin@example.com'); // ADMIN
    const projTeam = await prisma.team.create({ data: { name: 'Ops', slug: 'ops' } });
    const anchor = await prisma.team.create({ data: { name: 'Tech', slug: 'tech' } });
    const project = await prisma.project.create({ data: { teamId: projTeam.id, name: 'P' } });
    const dept = await prisma.userGroup.create({ data: { teamId: anchor.id, name: 'IT', kind: 'UNIT' } });

    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/projects/${project.id}/transfer-department`,
      headers: H(admin.token),
      payload: { toGroupId: dept.id },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.to.id).toBe(dept.id);
    expect(body.from).toBeNull();
    expect(body.grantsMoved).toBe(0);

    const active = await prisma.projectAccessGrant.findMany({
      where: { projectId: project.id, subjectType: 'GROUP', subjectId: dept.id, status: 'ACTIVE' },
    });
    expect(active.length).toBe(1);
  });

  it('rejects a target group that is not a UNIT department (400)', async () => {
    const admin = await register('admin@example.com');
    const team = await prisma.team.create({ data: { name: 'Div', slug: 'div' } });
    const project = await prisma.project.create({ data: { teamId: team.id, name: 'Proj' } });
    const collab = await prisma.userGroup.create({ data: { teamId: team.id, name: 'Collab', kind: 'COLLAB' } });

    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/projects/${project.id}/transfer-department`,
      headers: H(admin.token),
      payload: { toGroupId: collab.id },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects MEMBER callers with 403', async () => {
    await register('admin@example.com'); // ADMIN
    const member = await register('member@example.com'); // MEMBER
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/project-departments',
      headers: H(member.token),
    });
    expect(res.statusCode).toBe(403);
  });
});

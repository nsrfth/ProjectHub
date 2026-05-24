import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';

// v1.19: Task.technicianId + Subtask.technicianId.
//  - create defaults technicianId to creator
//  - members cannot change technicianId (403)
//  - team MANAGERS can change technicianId
//  - global ADMINs bypass the role check
//  - change rejected when target is not a team member (400)

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
  await prisma.subtask.deleteMany();
  await prisma.task.deleteMany();
  await prisma.project.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
});

const PASSWORD = 'CorrectHorseBattery9';

async function inject(opts: Parameters<FastifyInstance['inject']>[0]) {
  return app.inject(opts);
}

async function setup() {
  // First reg = global ADMIN.
  const adminReg = await inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email: 'admin@example.com', name: 'Admin', password: PASSWORD },
  });
  const adminToken = adminReg.json().accessToken as string;
  const adminId = adminReg.json().user.id as string;

  // Member: registered, then promoted out of admin-bystander to a real member.
  const memReg = await inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email: 'member@example.com', name: 'Mem', password: PASSWORD },
  });
  const memberToken = memReg.json().accessToken as string;
  const memberId = memReg.json().user.id as string;

  // Manager: third user, added as team MANAGER.
  const mgrReg = await inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email: 'mgr@example.com', name: 'Mgr', password: PASSWORD },
  });
  const mgrToken = mgrReg.json().accessToken as string;
  const mgrId = mgrReg.json().user.id as string;

  const team = await inject({
    method: 'POST',
    url: '/api/teams',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { name: 'TechTeam', slug: 'tech-team' },
  });
  const teamId = team.json().id as string;

  await inject({
    method: 'POST',
    url: `/api/teams/${teamId}/members`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { email: 'member@example.com', role: 'MEMBER' },
  });
  await inject({
    method: 'POST',
    url: `/api/teams/${teamId}/members`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { email: 'mgr@example.com', role: 'MANAGER' },
  });

  const project = await inject({
    method: 'POST',
    url: `/api/teams/${teamId}/projects`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { name: 'P' },
  });
  const projectId = project.json().id as string;

  return { adminToken, adminId, memberToken, memberId, mgrToken, mgrId, teamId, projectId };
}

describe('Task.technicianId', () => {
  it('defaults to creator on create + joins name', async () => {
    const { memberToken, memberId, teamId, projectId } = await setup();
    const res = await inject({
      method: 'POST',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks`,
      headers: { authorization: `Bearer ${memberToken}` },
      payload: { title: 'T' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().technicianId).toBe(memberId);
    expect(res.json().technicianName).toBe('Mem');
  });

  it('member CANNOT change technicianId (403)', async () => {
    const { adminToken, memberToken, mgrId, teamId, projectId } = await setup();
    const created = await inject({
      method: 'POST',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { title: 'T' },
    });
    const taskId = created.json().id as string;

    const res = await inject({
      method: 'PATCH',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks/${taskId}`,
      headers: { authorization: `Bearer ${memberToken}` },
      payload: { technicianId: mgrId },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/Technician/);
  });

  it('team MANAGER can reassign technicianId', async () => {
    const { adminToken, mgrToken, memberId, teamId, projectId } = await setup();
    const created = await inject({
      method: 'POST',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { title: 'T' },
    });
    const taskId = created.json().id as string;

    const res = await inject({
      method: 'PATCH',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks/${taskId}`,
      headers: { authorization: `Bearer ${mgrToken}` },
      payload: { technicianId: memberId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().technicianId).toBe(memberId);
  });

  it('rejects technicianId pointing at a non-team-member (400)', async () => {
    const { adminToken, mgrToken, teamId, projectId } = await setup();
    // Make a fourth user NOT in the team.
    const outsider = await inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'out@example.com', name: 'Out', password: PASSWORD },
    });
    const outsiderId = outsider.json().user.id as string;

    const created = await inject({
      method: 'POST',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { title: 'T' },
    });
    const taskId = created.json().id as string;

    const res = await inject({
      method: 'PATCH',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks/${taskId}`,
      headers: { authorization: `Bearer ${mgrToken}` },
      payload: { technicianId: outsiderId },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/team/i);
  });
});

describe('Subtask.technicianId', () => {
  it('defaults to creator on create', async () => {
    const { memberToken, memberId, teamId, projectId, adminToken } = await setup();
    const parent = await inject({
      method: 'POST',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { title: 'Parent' },
    });
    const taskId = parent.json().id as string;

    const sub = await inject({
      method: 'POST',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks/${taskId}/subtasks`,
      headers: { authorization: `Bearer ${memberToken}` },
      payload: { title: 'Subtask one' },
    });
    expect(sub.statusCode).toBe(201);
    expect(sub.json().technicianId).toBe(memberId);
    expect(sub.json().technicianName).toBe('Mem');
  });

  it('member CANNOT change subtask technicianId (403)', async () => {
    const { adminToken, memberToken, mgrId, teamId, projectId } = await setup();
    const parent = await inject({
      method: 'POST',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { title: 'Parent' },
    });
    const taskId = parent.json().id as string;
    const sub = await inject({
      method: 'POST',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks/${taskId}/subtasks`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { title: 'S' },
    });
    const subtaskId = sub.json().id as string;

    const res = await inject({
      method: 'PATCH',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks/${taskId}/subtasks/${subtaskId}`,
      headers: { authorization: `Bearer ${memberToken}` },
      payload: { technicianId: mgrId },
    });
    expect(res.statusCode).toBe(403);
  });
});

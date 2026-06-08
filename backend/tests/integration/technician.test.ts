import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';

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

// v1.39: the project must be owned by the test's primary non-admin actor
// so the visibility-gate cascade doesn't 404 before reaching the permission
// check we're trying to exercise. `projectOwner` picks which token owns
// the project ('member' default, 'mgr' for the manager-reassignment cases).
async function setup(projectOwner: 'member' | 'mgr' = 'member') {
  // First reg = global ADMIN.
  const adminReg = await bootstrapUser(app, { email: 'admin@example.com', name: 'Admin', password: PASSWORD });
  const adminToken = adminReg.token;
  const adminId = adminReg.userId;

  // Member: bootstrapped, then promoted out of admin-bystander to a real member.
  const memReg = await bootstrapUser(app, { email: 'member@example.com', name: 'Mem', password: PASSWORD });
  const memberToken = memReg.token;
  const memberId = memReg.userId;

  // Manager: third user, added as team MANAGER.
  const mgrReg = await bootstrapUser(app, { email: 'mgr@example.com', name: 'Mgr', password: PASSWORD });
  const mgrToken = mgrReg.token;
  const mgrId = mgrReg.userId;

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

  const ownerToken = projectOwner === 'mgr' ? mgrToken : memberToken;
  const project = await inject({
    method: 'POST',
    url: `/api/teams/${teamId}/projects`,
    headers: { authorization: `Bearer ${ownerToken}` },
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
    // v1.23: error message is now "Missing permission: task.change_technician"
    // (was "Only team managers or admins can change the assigned Technician"
    // pre-v1.23). The status code + the gist of the gate are unchanged.
    expect(res.json().error.message).toMatch(/task\.change_technician/);
  });

  it('team MANAGER can reassign technicianId', async () => {
    const { adminToken, mgrToken, memberId, teamId, projectId } = await setup('mgr');
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
    const { adminToken, mgrToken, teamId, projectId } = await setup('mgr');
    // Make a fourth user NOT in the team.
    const outsider = await bootstrapUser(app, { email: 'out@example.com', name: 'Out', password: PASSWORD });
    const outsiderId = outsider.userId;

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

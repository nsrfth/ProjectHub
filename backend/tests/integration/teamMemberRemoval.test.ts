import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { GlobalRole } from '@prisma/client';
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
  await prisma.activity.deleteMany();
  await prisma.task.deleteMany();
  await prisma.project.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
});

async function inject(opts: Parameters<FastifyInstance['inject']>[0]) {
  return app.inject(opts);
}

const PASSWORD = 'CorrectHorseBattery9';

type Blockers = {
  canRemove: boolean;
  ownedProjectCount: number;
  accountableProjectCount: number;
  ownedProjects: Array<{ id: string; name: string }>;
  accountableProjects: Array<{ id: string; name: string }>;
  reasons: string[];
};

async function mgr() {
  return bootstrapUser(app, {
    email: 'mgr@example.com',
    name: 'Manager',
    password: PASSWORD,
    globalRole: GlobalRole.MEMBER,
  });
}

async function user(email: string) {
  return bootstrapUser(app, {
    email,
    name: email.split('@')[0]!,
    password: PASSWORD,
    globalRole: GlobalRole.MEMBER,
  });
}

async function createTeam(token: string, slug: string) {
  return (
    await inject({
      method: 'POST',
      url: '/api/teams',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'T', slug },
    })
  ).json() as { id: string };
}

async function addMember(token: string, teamId: string, email: string) {
  await inject({
    method: 'POST',
    url: `/api/teams/${teamId}/members`,
    headers: { authorization: `Bearer ${token}` },
    payload: { email, role: 'MEMBER' },
  });
}

async function createProject(token: string, teamId: string, name: string) {
  return (
    await inject({
      method: 'POST',
      url: `/api/teams/${teamId}/projects`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name },
    })
  ).json() as { id: string; ownerId: string | null };
}

async function getBlockers(token: string, teamId: string, userId: string) {
  const res = await inject({
    method: 'GET',
    url: `/api/teams/${teamId}/members/${userId}/removal-blockers`,
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: res.statusCode, body: res.json() as Blockers };
}

async function removeMember(
  token: string,
  teamId: string,
  userId: string,
  body?: { reassignOwnerTo?: string; force?: boolean },
) {
  return inject({
    method: 'DELETE',
    url: `/api/teams/${teamId}/members/${userId}`,
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });
}

describe('Team member removal — ownership blockers (v1.56)', () => {
  it('1. removing a member who owns nothing succeeds as today', async () => {
    const manager = await mgr();
    const bob = await user('bob@example.com');
    const team = await createTeam(manager.token, 'rem-1');
    await addMember(manager.token, team.id, bob.email);

    const res = await removeMember(manager.token, team.id, bob.userId);
    expect(res.statusCode).toBe(204);

    const membership = await prisma.teamMembership.findUnique({
      where: { userId_teamId: { userId: bob.userId, teamId: team.id } },
    });
    expect(membership).toBeNull();
  });

  it('2. removing owner without reassign/force → 409 with blockers; member and projects untouched', async () => {
    const manager = await mgr();
    const owner = await user('owner@example.com');
    const team = await createTeam(manager.token, 'rem-2');
    await addMember(manager.token, team.id, owner.email);
    const project = await createProject(owner.token, team.id, 'Owned');

    const blockers = await getBlockers(manager.token, team.id, owner.userId);
    expect(blockers.status).toBe(200);
    expect(blockers.body.canRemove).toBe(false);
    expect(blockers.body.ownedProjectCount).toBe(1);
    expect(blockers.body.ownedProjects[0]!.name).toBe('Owned');

    const res = await removeMember(manager.token, team.id, owner.userId);
    expect(res.statusCode).toBe(409);
    const err = res.json() as { error: { details: Blockers } };
    expect(err.error.details.ownedProjectCount).toBe(1);

    const stillMember = await prisma.teamMembership.findUnique({
      where: { userId_teamId: { userId: owner.userId, teamId: team.id } },
    });
    expect(stillMember).not.toBeNull();

    const p = await prisma.project.findUnique({ where: { id: project.id } });
    expect(p!.ownerId).toBe(owner.userId);
  });

  it('3. removing with valid reassignOwnerTo reassigns projects, removes member, logs activity', async () => {
    const manager = await mgr();
    const owner = await user('owner@example.com');
    const team = await createTeam(manager.token, 'rem-3');
    await addMember(manager.token, team.id, owner.email);
    const project = await createProject(owner.token, team.id, 'Handoff');

    const res = await removeMember(manager.token, team.id, owner.userId, {
      reassignOwnerTo: manager.userId,
    });
    expect(res.statusCode).toBe(204);

    const p = await prisma.project.findUnique({ where: { id: project.id } });
    expect(p!.ownerId).toBe(manager.userId);

    const membership = await prisma.teamMembership.findUnique({
      where: { userId_teamId: { userId: owner.userId, teamId: team.id } },
    });
    expect(membership).toBeNull();

    const activity = await prisma.activity.findFirst({
      where: { teamId: team.id, action: 'project.owner_reassigned' },
    });
    expect(activity).not.toBeNull();
    expect(activity!.meta).toMatchObject({
      fromUserId: owner.userId,
      toUserId: manager.userId,
      reason: 'team_member_removed',
    });
  });

  it('4. reassign to non-member or removed user → 400, nothing changed', async () => {
    const manager = await mgr();
    const owner = await user('owner@example.com');
    const outsider = await user('outsider@example.com');
    const team = await createTeam(manager.token, 'rem-4');
    await addMember(manager.token, team.id, owner.email);
    const project = await createProject(owner.token, team.id, 'P');

    const toSelf = await removeMember(manager.token, team.id, owner.userId, {
      reassignOwnerTo: owner.userId,
    });
    expect(toSelf.statusCode).toBe(400);

    const toOutsider = await removeMember(manager.token, team.id, owner.userId, {
      reassignOwnerTo: outsider.userId,
    });
    expect(toOutsider.statusCode).toBe(400);

    const p = await prisma.project.findUnique({ where: { id: project.id } });
    expect(p!.ownerId).toBe(owner.userId);
    const stillMember = await prisma.teamMembership.findUnique({
      where: { userId_teamId: { userId: owner.userId, teamId: team.id } },
    });
    expect(stillMember).not.toBeNull();
  });

  it('5. force:true removes member; ownerId unchanged on projects', async () => {
    const manager = await mgr();
    const owner = await user('owner@example.com');
    const team = await createTeam(manager.token, 'rem-5');
    await addMember(manager.token, team.id, owner.email);
    const project = await createProject(owner.token, team.id, 'Orphaned');

    const res = await removeMember(manager.token, team.id, owner.userId, { force: true });
    expect(res.statusCode).toBe(204);

    const membership = await prisma.teamMembership.findUnique({
      where: { userId_teamId: { userId: owner.userId, teamId: team.id } },
    });
    expect(membership).toBeNull();

    const p = await prisma.project.findUnique({ where: { id: project.id } });
    expect(p!.ownerId).toBe(owner.userId);
  });

  it('6. last-MANAGER guard still blocks regardless of ownership options', async () => {
    const manager = await mgr();
    const team = await createTeam(manager.token, 'rem-6');
    const project = await createProject(manager.token, team.id, 'MgrOwned');

    const res = await removeMember(manager.token, team.id, manager.userId, {
      reassignOwnerTo: manager.userId,
      force: true,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/last MANAGER/i);

    const stillMember = await prisma.teamMembership.findUnique({
      where: { userId_teamId: { userId: manager.userId, teamId: team.id } },
    });
    expect(stillMember).not.toBeNull();

    const p = await prisma.project.findUnique({ where: { id: project.id } });
    expect(p!.ownerId).toBe(manager.userId);
  });

  it('7. blockers endpoint scoped to THIS team projects only', async () => {
    const mgrA = await mgr();
    const mgrB = await user('mgrb@example.com');
    const owner = await user('owner@example.com');
    const teamA = await createTeam(mgrA.token, 'rem-7a');
    const teamB = await createTeam(mgrB.token, 'rem-7b');
    await addMember(mgrA.token, teamA.id, owner.email);

    await createProject(owner.token, teamA.id, 'In A');
    await createProject(mgrB.token, teamB.id, 'In B');
    await prisma.project.updateMany({
      where: { teamId: teamB.id },
      data: { ownerId: owner.userId },
    });

    const blockers = await getBlockers(mgrA.token, teamA.id, owner.userId);
    expect(blockers.body.ownedProjectCount).toBe(1);
    expect(blockers.body.ownedProjects).toHaveLength(1);
    expect(blockers.body.ownedProjects[0]!.name).toBe('In A');
  });
});

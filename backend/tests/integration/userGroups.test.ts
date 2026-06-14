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
  await prisma.refreshToken.deleteMany();
  await prisma.projectGroupGrant.deleteMany();
  await prisma.userGroupMember.deleteMany();
  await prisma.userGroup.deleteMany();
  await prisma.task.deleteMany();
  await prisma.project.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.rolePermission.deleteMany();
  await prisma.role.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
});

async function inject(opts: Parameters<FastifyInstance['inject']>[0]) {
  return app.inject(opts);
}

const PASSWORD = 'CorrectHorseBattery9';

async function registerUser(email: string) {
  return bootstrapUser(app, { email, name: email, password: PASSWORD });
}

async function registerMember(email: string) {
  return bootstrapUser(app, {
    email,
    name: email,
    password: PASSWORD,
    globalRole: GlobalRole.MEMBER,
  });
}

async function createTeam(token: string, slug: string) {
  const res = await inject({
    method: 'POST',
    url: '/api/teams',
    headers: { authorization: `Bearer ${token}` },
    payload: { name: slug, slug },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string };
}

async function addMember(
  mgrToken: string,
  teamId: string,
  email: string,
  role: 'MEMBER' | 'MANAGER',
) {
  const res = await inject({
    method: 'POST',
    url: `/api/teams/${teamId}/members`,
    headers: { authorization: `Bearer ${mgrToken}` },
    payload: { email, role },
  });
  expect(res.statusCode).toBe(201);
}

async function createProject(token: string, teamId: string, name: string) {
  const res = await inject({
    method: 'POST',
    url: `/api/teams/${teamId}/projects`,
    headers: { authorization: `Bearer ${token}` },
    payload: { name },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; name: string };
}

async function createGroup(mgrToken: string, teamId: string, name: string) {
  const res = await inject({
    method: 'POST',
    url: `/api/teams/${teamId}/groups`,
    headers: { authorization: `Bearer ${mgrToken}` },
    payload: { name },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string };
}

describe('User Groups — project access (v1.50)', () => {
  it('1. owner unchanged — full access to own project', async () => {
    const admin = await registerUser('admin1@example.com');
    const owner = await registerMember('owner1@example.com');
    const team = await createTeam(admin.token, 'team-1');
    await addMember(admin.token, team.id, owner.email, 'MEMBER');
    const proj = await createProject(owner.token, team.id, 'Mine');

    const tasks = await inject({
      method: 'GET',
      url: `/api/teams/${team.id}/projects/${proj.id}/tasks`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(tasks.statusCode).toBe(200);

    const created = await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects/${proj.id}/tasks`,
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { title: 'Owner task' },
    });
    expect(created.statusCode).toBe(201);
  });

  it('2. group grant — list shows project to non-owner member', async () => {
    const admin = await registerUser('admin2@example.com');
    const owner = await registerMember('owner2@example.com');
    const grantee = await registerMember('grantee2@example.com');
    const team = await createTeam(admin.token, 'team-2');
    await addMember(admin.token, team.id, owner.email, 'MEMBER');
    await addMember(admin.token, team.id, grantee.email, 'MEMBER');
    const proj = await createProject(owner.token, team.id, 'Shared');
    const group = await createGroup(admin.token, team.id, 'Readers');
    await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/groups/${group.id}/members`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { userIds: [grantee.userId] },
    });
    await inject({
      method: 'PUT',
      url: `/api/teams/${team.id}/groups/${group.id}/projects`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { projectIds: [proj.id] },
    });

    const list = await inject({
      method: 'GET',
      url: '/api/projects',
      headers: { authorization: `Bearer ${grantee.token}` },
    });
    expect(list.statusCode).toBe(200);
    const ids = (list.json() as Array<{ id: string }>).map((p) => p.id);
    expect(ids).toContain(proj.id);
  });

  it('3. group grant — nested routes (list tasks + create task)', async () => {
    const admin = await registerUser('admin3@example.com');
    const owner = await registerMember('owner3@example.com');
    const grantee = await registerMember('grantee3@example.com');
    const team = await createTeam(admin.token, 'team-3');
    await addMember(admin.token, team.id, owner.email, 'MEMBER');
    await addMember(admin.token, team.id, grantee.email, 'MEMBER');
    const proj = await createProject(owner.token, team.id, 'Nested');
    const group = await createGroup(admin.token, team.id, 'Workers');
    await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/groups/${group.id}/members`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { userIds: [grantee.userId] },
    });
    await inject({
      method: 'PUT',
      url: `/api/teams/${team.id}/groups/${group.id}/projects`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { projectIds: [proj.id] },
    });

    const list = await inject({
      method: 'GET',
      url: `/api/teams/${team.id}/projects/${proj.id}/tasks`,
      headers: { authorization: `Bearer ${grantee.token}` },
    });
    expect(list.statusCode).toBe(200);

    const created = await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects/${proj.id}/tasks`,
      headers: { authorization: `Bearer ${grantee.token}` },
      payload: { title: 'Granted task' },
    });
    expect(created.statusCode).toBe(201);
  });

  it('4. no grant — team member without group gets 404 on nested routes', async () => {
    const admin = await registerUser('admin4@example.com');
    const owner = await registerMember('owner4@example.com');
    const outsider = await registerMember('outsider4@example.com');
    const team = await createTeam(admin.token, 'team-4');
    await addMember(admin.token, team.id, owner.email, 'MEMBER');
    await addMember(admin.token, team.id, outsider.email, 'MEMBER');
    const proj = await createProject(owner.token, team.id, 'Private');

    const res = await inject({
      method: 'GET',
      url: `/api/teams/${team.id}/projects/${proj.id}/tasks`,
      headers: { authorization: `Bearer ${outsider.token}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('5. cross-team isolation — grant in team A does not expose team B project', async () => {
    const admin = await registerUser('admin5@example.com');
    const ownerA = await registerMember('ownera5@example.com');
    const userB = await registerMember('userb5@example.com');
    const teamA = await createTeam(admin.token, 'team-a5');
    const teamB = await createTeam(admin.token, 'team-b5');
    await addMember(admin.token, teamA.id, ownerA.email, 'MEMBER');
    await addMember(admin.token, teamB.id, userB.email, 'MEMBER');
    const projB = await createProject(userB.token, teamB.id, 'B only');
    const group = await createGroup(admin.token, teamA.id, 'Wrong team');
    await inject({
      method: 'POST',
      url: `/api/teams/${teamA.id}/groups/${group.id}/members`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { userIds: [ownerA.userId] },
    });
    const badGrant = await inject({
      method: 'PUT',
      url: `/api/teams/${teamA.id}/groups/${group.id}/projects`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { projectIds: [projB.id] },
    });
    expect(badGrant.statusCode).toBe(404);
  });

  it('6. removal revokes — removing member drops nested access', async () => {
    const admin = await registerUser('admin6@example.com');
    const owner = await registerMember('owner6@example.com');
    const grantee = await registerMember('grantee6@example.com');
    const team = await createTeam(admin.token, 'team-6');
    await addMember(admin.token, team.id, owner.email, 'MEMBER');
    await addMember(admin.token, team.id, grantee.email, 'MEMBER');
    const proj = await createProject(owner.token, team.id, 'Revoke');
    const group = await createGroup(admin.token, team.id, 'Temp');
    await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/groups/${group.id}/members`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { userIds: [grantee.userId] },
    });
    await inject({
      method: 'PUT',
      url: `/api/teams/${team.id}/groups/${group.id}/projects`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { projectIds: [proj.id] },
    });

    const del = await inject({
      method: 'DELETE',
      url: `/api/teams/${team.id}/groups/${group.id}/members/${grantee.userId}`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(del.statusCode).toBe(204);

    const res = await inject({
      method: 'GET',
      url: `/api/teams/${team.id}/projects/${proj.id}/tasks`,
      headers: { authorization: `Bearer ${grantee.token}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('7. admin bypass intact; project.edit manager rename unchanged', async () => {
    const admin = await registerUser('admin7@example.com');
    const owner = await registerMember('owner7@example.com');
    const manager = await registerMember('mgr7@example.com');
    const team = await createTeam(admin.token, 'team-7');
    await addMember(admin.token, team.id, owner.email, 'MEMBER');
    await addMember(admin.token, team.id, manager.email, 'MANAGER');
    const proj = await createProject(owner.token, team.id, 'AdminView');

    const adminGet = await inject({
      method: 'GET',
      url: `/api/teams/${team.id}/projects/${proj.id}/tasks`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(adminGet.statusCode).toBe(200);

    const rename = await inject({
      method: 'PATCH',
      url: `/api/teams/${team.id}/projects/${proj.id}`,
      headers: { authorization: `Bearer ${manager.token}` },
      payload: { name: 'Renamed by mgr' },
    });
    expect(rename.statusCode).toBe(200);
    expect(rename.json().name).toBe('Renamed by mgr');

    const mgrTasks = await inject({
      method: 'GET',
      url: `/api/teams/${team.id}/projects/${proj.id}/tasks`,
      headers: { authorization: `Bearer ${manager.token}` },
    });
    expect(mgrTasks.statusCode).toBe(404);
  });

  it('8. cascade — deleting group removes grants; project survives', async () => {
    const admin = await registerUser('admin8@example.com');
    const owner = await registerMember('owner8@example.com');
    const grantee = await registerMember('grantee8@example.com');
    const team = await createTeam(admin.token, 'team-8');
    await addMember(admin.token, team.id, owner.email, 'MEMBER');
    await addMember(admin.token, team.id, grantee.email, 'MEMBER');
    const proj = await createProject(owner.token, team.id, 'Survives');
    const group = await createGroup(admin.token, team.id, 'Gone');
    await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/groups/${group.id}/members`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { userIds: [grantee.userId] },
    });
    await inject({
      method: 'PUT',
      url: `/api/teams/${team.id}/groups/${group.id}/projects`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { projectIds: [proj.id] },
    });

    const del = await inject({
      method: 'DELETE',
      url: `/api/teams/${team.id}/groups/${group.id}`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(del.statusCode).toBe(204);

    expect(await prisma.project.findUnique({ where: { id: proj.id } })).not.toBeNull();
    expect(await prisma.userGroup.findUnique({ where: { id: group.id } })).toBeNull();
    expect(await prisma.projectGroupGrant.count()).toBe(0);

    const res = await inject({
      method: 'GET',
      url: `/api/teams/${team.id}/projects/${proj.id}/tasks`,
      headers: { authorization: `Bearer ${grantee.token}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

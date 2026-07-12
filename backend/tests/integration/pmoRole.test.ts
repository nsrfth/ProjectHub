import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { HOLDING_ROOT_ID } from '../../src/lib/orgUnitTree.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';

// v2.5.54: PMO (Project Management Office) oversight role.
//   - `project.read_all` — READ (never WRITE) to every project in the team.
//   - PMO seeded as a third system role per team (Manager / Member / PMO).
//   - portfolio.* resolves for a non-admin PMO on the global org-unit routes.

let app: FastifyInstance;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_ACCESS_SECRET ||= 'test_access_secret_at_least_32_chars_long_xx';
  process.env.JWT_REFRESH_SECRET ||= 'test_refresh_secret_at_least_32_chars_long_x';
  process.env.CORS_ORIGINS ||= 'http://localhost:5173';
  process.env.COOKIE_SECURE ||= 'false';
  process.env.MASTER_KEY ??=
    '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
  app = await buildApp(loadEnv());
});

afterAll(async () => {
  if (app) await app.close();
});

beforeEach(async () => {
  await prisma.projectBaseline.deleteMany();
  await prisma.task.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.teamOrgUnit.deleteMany();
  await prisma.orgUnit.deleteMany({ where: { id: { not: HOLDING_ROOT_ID } } });
  await prisma.project.deleteMany();
  await prisma.rolePermission.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.role.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
  await prisma.instanceSetting.deleteMany();
});

const PASSWORD = 'CorrectHorseBattery9';

async function register(email: string, globalRole: 'ADMIN' | 'MEMBER') {
  const r = await bootstrapUser(app, { email, name: email.split('@')[0], password: PASSWORD, globalRole });
  return { token: r.token, userId: r.userId };
}

async function createTeam(token: string, slug: string): Promise<string> {
  const r = await app.inject({
    method: 'POST',
    url: '/api/teams',
    headers: { authorization: `Bearer ${token}` },
    payload: { name: slug, slug },
  });
  if (r.statusCode !== 201) throw new Error(`createTeam failed: ${r.statusCode} ${r.body}`);
  return r.json().id as string;
}

async function createProject(token: string, teamId: string, name = 'P1'): Promise<string> {
  const r = await app.inject({
    method: 'POST',
    url: `/api/teams/${teamId}/projects`,
    headers: { authorization: `Bearer ${token}` },
    payload: { name },
  });
  if (r.statusCode !== 201) throw new Error(`createProject failed: ${r.statusCode} ${r.body}`);
  return r.json().id as string;
}

async function addMember(
  adminToken: string,
  teamId: string,
  email: string,
  role: 'MEMBER' | 'MANAGER',
): Promise<void> {
  const r = await app.inject({
    method: 'POST',
    url: `/api/teams/${teamId}/members`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { email, role },
  });
  if (r.statusCode !== 201) throw new Error(`addMember failed: ${r.statusCode} ${r.body}`);
}

// Look up the team's seeded PMO system role and pin the membership to it.
async function assignPmo(teamId: string, userId: string): Promise<string> {
  const pmo = await prisma.role.findUnique({ where: { teamId_name: { teamId, name: 'PMO' } } });
  if (!pmo) throw new Error('PMO system role was not seeded on team create');
  await prisma.teamMembership.update({
    where: { userId_teamId: { userId, teamId } },
    data: { roleId: pmo.id },
  });
  return pmo.id;
}

function createTask(token: string, teamId: string, projectId: string, title = 'New task') {
  return app.inject({
    method: 'POST',
    url: `/api/teams/${teamId}/projects/${projectId}/tasks`,
    headers: { authorization: `Bearer ${token}` },
    payload: { title },
  });
}

function listTasks(token: string, teamId: string, projectId: string) {
  return app.inject({
    method: 'GET',
    url: `/api/teams/${teamId}/projects/${projectId}/tasks`,
    headers: { authorization: `Bearer ${token}` },
  });
}

describe('PMO role — read-only cross-project oversight (project.read_all)', () => {
  it('lets a PMO READ a non-owned team project’s tasks but denies writing (403, not 404)', async () => {
    const admin = await register('admin@x.com', 'ADMIN');
    const team = await createTeam(admin.token, 'team-a');
    const project = await createProject(admin.token, team.id); // owned by admin, PMO is not owner
    const pmo = await register('pmo@x.com', 'MEMBER');
    await addMember(admin.token, team.id, 'pmo@x.com', 'MEMBER');
    await assignPmo(team.id, pmo.userId);

    // READ: nested task list of a project the PMO neither owns nor was granted.
    const read = await listTasks(pmo.token, team.id, project.id);
    expect(read.statusCode).toBe(200);

    // WRITE: read_all resolves to READ, so requireProjectWriteAccess → 403
    // (a plain member with NO access would get 404 — proving PMO has READ).
    const write = await createTask(pmo.token, team.id, project.id);
    expect(write.statusCode).toBe(403);
  });

  it('shows every team project to a PMO in the project list', async () => {
    const admin = await register('admin@x.com', 'ADMIN');
    const team = await createTeam(admin.token, 'team-a');
    const p1 = await createProject(admin.token, team.id, 'Alpha');
    const p2 = await createProject(admin.token, team.id, 'Beta');
    const pmo = await register('pmo@x.com', 'MEMBER');
    await addMember(admin.token, team.id, 'pmo@x.com', 'MEMBER');
    await assignPmo(team.id, pmo.userId);

    const res = await app.inject({
      method: 'GET',
      url: `/api/teams/${team.id}/projects`,
      headers: { authorization: `Bearer ${pmo.token}` },
    });
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as Array<{ id: string }>).map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining([p1, p2]));
  });

  it('does NOT leak read_all across teams (PMO of A gets no oversight in B)', async () => {
    const admin = await register('admin@x.com', 'ADMIN');
    const teamA = await createTeam(admin.token, 'team-a');
    const teamB = await createTeam(admin.token, 'team-b');
    const projectB = await createProject(admin.token, teamB.id, 'PB'); // admin-owned in B
    const user = await register('u@x.com', 'MEMBER');
    await addMember(admin.token, teamA.id, 'u@x.com', 'MEMBER');
    await assignPmo(teamA.id, user.userId); // PMO in A only
    await addMember(admin.token, teamB.id, 'u@x.com', 'MEMBER'); // plain member in B

    // In B the user is a plain member: no read_all, so B's admin-owned project
    // is invisible in the list and its tasks are not writable (404 = no access).
    const list = await app.inject({
      method: 'GET',
      url: `/api/teams/${teamB.id}/projects`,
      headers: { authorization: `Bearer ${user.token}` },
    });
    expect(list.statusCode).toBe(200);
    const ids = (list.json() as Array<{ id: string }>).map((p) => p.id);
    expect(ids).not.toContain(projectB);

    const write = await createTask(user.token, teamB.id, projectB);
    expect(write.statusCode).toBe(404);
  });
});

describe('PMO role — system-role seeding', () => {
  it('seeds a PMO system role on every new team, oversight-first and read-only', async () => {
    const admin = await register('admin@x.com', 'ADMIN');
    const team = await createTeam(admin.token, 'team-a');
    const role = await prisma.role.findUnique({
      where: { teamId_name: { teamId: team.id, name: 'PMO' } },
      include: { permissions: true },
    });
    expect(role?.isSystem).toBe(true);
    const perms = role?.permissions.map((p) => p.permission) ?? [];
    // Has: read-all oversight, profile/standards governance, portfolio view.
    expect(perms).toEqual(
      expect.arrayContaining(['project.read_all', 'pmo.manage_profiles', 'portfolio.view']),
    );
    // Read-only on content: no authoring writes.
    expect(perms).not.toContain('project.write_all');
    expect(perms).not.toContain('task.delete');
    expect(perms).not.toContain('cost.manage');
  });

  it('backfills project.read_all onto the Manager system role', async () => {
    const admin = await register('admin@x.com', 'ADMIN');
    const team = await createTeam(admin.token, 'team-a');
    const role = await prisma.role.findUnique({
      where: { teamId_name: { teamId: team.id, name: 'Manager' } },
      include: { permissions: true },
    });
    const perms = role?.permissions.map((p) => p.permission) ?? [];
    expect(perms).toContain('project.read_all');
  });

  it('assigns PMO via the members API and mirrors it to the MEMBER legacy enum', async () => {
    const admin = await register('admin@x.com', 'ADMIN');
    const team = await createTeam(admin.token, 'team-a');
    const user = await register('u@x.com', 'MEMBER');
    await addMember(admin.token, team.id, 'u@x.com', 'MEMBER');
    const pmoRole = await prisma.role.findUnique({
      where: { teamId_name: { teamId: team.id, name: 'PMO' } },
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/teams/${team.id}/members/${user.userId}`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { roleId: pmoRole!.id },
    });
    expect(res.statusCode).toBe(200);

    const membership = await prisma.teamMembership.findUnique({
      where: { userId_teamId: { userId: user.userId, teamId: team.id } },
    });
    expect(membership?.roleId).toBe(pmoRole!.id);
    // Custom (non-Manager) role mirrors to the MEMBER legacy enum so the
    // requireTeamRole('MEMBER','MANAGER') gate still admits the PMO.
    expect(membership?.role).toBe('MEMBER');
  });
});

describe('PMO role — portfolio access on global org-unit routes', () => {
  it('lets a non-admin PMO view the global portfolio tree, but denies a plain member', async () => {
    const admin = await register('admin@x.com', 'ADMIN');
    const team = await createTeam(admin.token, 'team-a');

    const pmo = await register('pmo@x.com', 'MEMBER');
    await addMember(admin.token, team.id, 'pmo@x.com', 'MEMBER');
    await assignPmo(team.id, pmo.userId);

    const member = await register('mem@x.com', 'MEMBER');
    await addMember(admin.token, team.id, 'mem@x.com', 'MEMBER');

    // PMO holds portfolio.view via its team role → resolves on the global route.
    const pmoView = await app.inject({
      method: 'GET',
      url: '/api/org-units/tree',
      headers: { authorization: `Bearer ${pmo.token}` },
    });
    expect(pmoView.statusCode).toBe(200);

    // Plain member has no portfolio.view anywhere → 403.
    const memberView = await app.inject({
      method: 'GET',
      url: '/api/org-units/tree',
      headers: { authorization: `Bearer ${member.token}` },
    });
    expect(memberView.statusCode).toBe(403);
  });
});

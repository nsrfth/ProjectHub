import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';

// Audit-log viewer integration coverage. Verifies the role gating (ADMIN /
// MANAGER / MEMBER), filter handling, pagination, and that logActivity
// fills teamId so the team-scoped query actually finds matching rows.

let app: FastifyInstance;

beforeAll(async () => {
  process.env.MASTER_KEY ??= '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
  app = await buildApp(loadEnv());
});

afterAll(async () => {
  if (app) await app.close();
});

beforeEach(async () => {
  await prisma.refreshToken.deleteMany();
  await prisma.activity.deleteMany();
  await prisma.task.deleteMany();
  await prisma.project.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
});

const PASSWORD = 'CorrectHorseBattery9';

async function register(email: string): Promise<{ token: string; userId: string }> {
  const r = await bootstrapUser(app, { email, name: email.split('@')[0], password: PASSWORD });
  return { token: r.token, userId: r.userId };
}

async function createTeam(token: string, slug: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/teams',
    headers: { authorization: `Bearer ${token}` },
    payload: { name: slug, slug },
  });
  return res.json().id;
}

async function createProject(token: string, teamId: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/teams/${teamId}/projects`,
    headers: { authorization: `Bearer ${token}` },
    payload: { name: 'P' },
  });
  return res.json().id;
}

async function createTask(token: string, teamId: string, projectId: string, title: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/teams/${teamId}/projects/${projectId}/tasks`,
    headers: { authorization: `Bearer ${token}` },
    payload: { title },
  });
  return res.json().id;
}

async function addMember(managerToken: string, teamId: string, email: string, role: 'MEMBER' | 'MANAGER' = 'MEMBER') {
  await app.inject({
    method: 'POST',
    url: `/api/teams/${teamId}/members`,
    headers: { authorization: `Bearer ${managerToken}` },
    payload: { email, role },
  });
}

async function fetchAudit(token: string, query: Record<string, string> = {}) {
  const qs = new URLSearchParams(query).toString();
  return app.inject({
    method: 'GET',
    url: `/api/audit${qs ? `?${qs}` : ''}`,
    headers: { authorization: `Bearer ${token}` },
  });
}

describe('GET /api/audit', () => {
  it('returns task.created entries with denormalized teamId set by logActivity', async () => {
    // First registered user becomes ADMIN.
    const admin = await register('admin@example.com');
    const teamId = await createTeam(admin.token, 'team-a');
    const projectId = await createProject(admin.token, teamId);
    await createTask(admin.token, teamId, projectId, 'task one');

    const res = await fetchAudit(admin.token);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    const created = body.items.find((i: { action: string }) => i.action === 'task.created');
    expect(created).toBeTruthy();
    expect(created.teamId).toBe(teamId);
    expect(created.teamName).toBe('team-a');
    expect(created.taskTitle).toBe('task one');
    expect(created.actorName).toBe('admin');
  });

  it('ADMIN sees rows across multiple teams; MANAGER sees only their team', async () => {
    const admin = await register('a@example.com');
    const teamA = await createTeam(admin.token, 'team-a');
    const projA = await createProject(admin.token, teamA);
    await createTask(admin.token, teamA, projA, 'a-task');

    // Second team owned by a different MANAGER (Bob). Bob is not in team-a.
    const bob = await register('bob@example.com');
    const teamB = await createTeam(bob.token, 'team-b');
    const projB = await createProject(bob.token, teamB);
    await createTask(bob.token, teamB, projB, 'b-task');

    // Admin sees both task.created rows.
    const adminRes = await fetchAudit(admin.token);
    const adminTitles = (adminRes.json().items as { action: string; taskTitle: string }[])
      .filter((i) => i.action === 'task.created').map((i) => i.taskTitle).sort();
    expect(adminTitles).toEqual(['a-task', 'b-task']);

    // Bob (manager of team-b only) sees only his row.
    const bobRes = await fetchAudit(bob.token);
    expect(bobRes.statusCode).toBe(200);
    const bobTitles = (bobRes.json().items as { action: string; taskTitle: string }[])
      .filter((i) => i.action === 'task.created').map((i) => i.taskTitle);
    expect(bobTitles).toEqual(['b-task']);
  });

  it('MEMBER (no manager role anywhere) gets 403', async () => {
    const admin = await register('admin@example.com');
    const team = await createTeam(admin.token, 'team-a');
    await createProject(admin.token, team);
    // Add a plain member.
    const member = await register('member@example.com');
    await addMember(admin.token, team, 'member@example.com', 'MEMBER');

    // Re-login as the member to get a fresh JWT that reflects their (still
    // MEMBER) global role — though globalRole defaults to MEMBER on the
    // second registration anyway.
    const memberRes = await fetchAudit(member.token);
    expect(memberRes.statusCode).toBe(403);
  });

  it('MANAGER cannot ask for another team`s audit by passing teamId', async () => {
    const admin = await register('a@example.com');
    const teamA = await createTeam(admin.token, 'team-a');
    await createProject(admin.token, teamA);

    const bob = await register('bob@example.com');
    const teamB = await createTeam(bob.token, 'team-b');

    // Bob asks for teamA — he doesn't manage it.
    const res = await fetchAudit(bob.token, { teamId: teamA });
    expect(res.statusCode).toBe(403);
    // Bob asks for his own team — fine.
    const ok = await fetchAudit(bob.token, { teamId: teamB });
    expect(ok.statusCode).toBe(200);
  });

  it('filters by action substring and actor id', async () => {
    const admin = await register('a@example.com');
    const team = await createTeam(admin.token, 'team-a');
    const proj = await createProject(admin.token, team);
    const taskId = await createTask(admin.token, team, proj, 'filtertask');
    // Trigger a status change to emit task.status_changed.
    await app.inject({
      method: 'PATCH',
      url: `/api/teams/${team}/projects/${proj}/tasks/${taskId}`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { status: 'IN_PROGRESS' },
    });

    const onlyStatus = await fetchAudit(admin.token, { action: 'status_changed' });
    const actions = (onlyStatus.json().items as { action: string }[]).map((i) => i.action);
    expect(actions.every((a) => a.includes('status_changed'))).toBe(true);

    const byActor = await fetchAudit(admin.token, { actorId: admin.userId });
    const everyActor = (byActor.json().items as { actorId: string }[]).map((i) => i.actorId);
    expect(everyActor.every((a) => a === admin.userId)).toBe(true);
  });

  it('paginates via nextCursor', async () => {
    const admin = await register('a@example.com');
    const team = await createTeam(admin.token, 'team-a');
    const proj = await createProject(admin.token, team);
    // Emit 5 task.created rows.
    for (let i = 0; i < 5; i++) {
      await createTask(admin.token, team, proj, `t${i}`);
    }
    const page1 = await fetchAudit(admin.token, { limit: '2' });
    const body1 = page1.json();
    expect(body1.items).toHaveLength(2);
    expect(body1.nextCursor).toBeTruthy();

    const page2 = await fetchAudit(admin.token, { limit: '2', cursor: body1.nextCursor });
    const body2 = page2.json();
    expect(body2.items).toHaveLength(2);
    // No overlap between pages.
    const ids1 = body1.items.map((i: { id: string }) => i.id);
    const ids2 = body2.items.map((i: { id: string }) => i.id);
    expect(ids1.some((id: string) => ids2.includes(id))).toBe(false);
  });
});

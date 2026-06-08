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
  const env = loadEnv();
  app = await buildApp(env);
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await prisma.refreshToken.deleteMany();
  await prisma.passwordReset.deleteMany();
  // Notifications cascade from user/team — clearing those is sufficient, but
  // be explicit so a failed cascade can't pollute later tests.
  await prisma.notification.deleteMany();
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

async function register(email: string): Promise<{ token: string; userId: string }> {
  const r = await bootstrapUser(app, { email, name: email.split('@')[0], password: PASSWORD });
  return { token: r.token, userId: r.userId };
}

async function setupTeamWithMembers() {
  const owner = await register('owner@example.com');
  const member = await register('member@example.com');
  const team = (
    await inject({
      method: 'POST',
      url: '/api/teams',
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { name: 'T', slug: 'team-t' },
    })
  ).json();
  await inject({
    method: 'POST',
    url: `/api/teams/${team.id}/members`,
    headers: { authorization: `Bearer ${owner.token}` },
    payload: { email: 'member@example.com', role: 'MEMBER' },
  });
  // v1.39: project owned by `member` so the visibility-gate cascade lets
  // them comment / change status on tasks the owner created. Admin still
  // bypasses (owner = first-bootstrapped user = global ADMIN), so the
  // existing "owner creates the task" calls keep working.
  const project = (
    await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects`,
      headers: { authorization: `Bearer ${member.token}` },
      payload: { name: 'P' },
    })
  ).json();
  return { owner, member, teamId: team.id, projectId: project.id };
}

async function listNotifications(token: string) {
  const r = await inject({
    method: 'GET',
    url: '/api/notifications',
    headers: { authorization: `Bearer ${token}` },
  });
  expect(r.statusCode).toBe(200);
  return r.json() as Array<{ id: string; type: string; payload: Record<string, unknown>; readAt: string | null }>;
}

describe('notifications fan-out', () => {
  it('notifies the new assignee on task creation, not the creator', async () => {
    const s = await setupTeamWithMembers();
    // Owner creates a task assigned to member.
    await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks`,
      headers: { authorization: `Bearer ${s.owner.token}` },
      payload: { title: 'Assigned to member', assigneeId: s.member.userId },
    });

    const memberInbox = await listNotifications(s.member.token);
    const ownerInbox = await listNotifications(s.owner.token);
    expect(memberInbox).toHaveLength(1);
    expect(memberInbox[0].type).toBe('TASK_ASSIGNED');
    expect(ownerInbox).toHaveLength(0); // actor isn't notified
  });

  it('does not notify the assignee if they assigned themselves', async () => {
    const s = await setupTeamWithMembers();
    await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks`,
      headers: { authorization: `Bearer ${s.owner.token}` },
      payload: { title: 'Self-assigned', assigneeId: s.owner.userId },
    });
    const ownerInbox = await listNotifications(s.owner.token);
    expect(ownerInbox).toHaveLength(0);
  });

  it('notifies assignee + creator on comment (excluding the commenter)', async () => {
    const s = await setupTeamWithMembers();
    const task = (
      await inject({
        method: 'POST',
        url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks`,
        headers: { authorization: `Bearer ${s.owner.token}` },
        payload: { title: 'T', assigneeId: s.member.userId },
      })
    ).json();
    // Member (the commenter) shouldn't be notified; owner (creator) should be.
    await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${task.id}/comments`,
      headers: { authorization: `Bearer ${s.member.token}` },
      payload: { body: 'I have a question' },
    });

    const memberInbox = await listNotifications(s.member.token);
    const ownerInbox = await listNotifications(s.owner.token);

    // Member only has the TASK_ASSIGNED from creation, no TASK_COMMENT.
    expect(memberInbox.filter((n) => n.type === 'TASK_COMMENT')).toHaveLength(0);
    expect(ownerInbox.filter((n) => n.type === 'TASK_COMMENT')).toHaveLength(1);
  });

  it('notifies on status change to creator+assignee, excluding actor', async () => {
    const s = await setupTeamWithMembers();
    const task = (
      await inject({
        method: 'POST',
        url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks`,
        headers: { authorization: `Bearer ${s.owner.token}` },
        payload: { title: 'T', assigneeId: s.member.userId },
      })
    ).json();

    // Member moves the task to IN_PROGRESS. Owner (creator) should be notified.
    await inject({
      method: 'PATCH',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${task.id}`,
      headers: { authorization: `Bearer ${s.member.token}` },
      payload: { status: 'IN_PROGRESS' },
    });

    const ownerInbox = await listNotifications(s.owner.token);
    const statusNotifs = ownerInbox.filter((n) => n.type === 'TASK_STATUS');
    expect(statusNotifs).toHaveLength(1);
    expect(statusNotifs[0].payload.from).toBe('TODO');
    expect(statusNotifs[0].payload.to).toBe('IN_PROGRESS');
  });
});

describe('read-side endpoints', () => {
  it('unread-count tracks markRead and markAllRead', async () => {
    const s = await setupTeamWithMembers();
    // Generate two notifications for member.
    await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks`,
      headers: { authorization: `Bearer ${s.owner.token}` },
      payload: { title: 'A', assigneeId: s.member.userId },
    });
    await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks`,
      headers: { authorization: `Bearer ${s.owner.token}` },
      payload: { title: 'B', assigneeId: s.member.userId },
    });

    let count = (
      await inject({
        method: 'GET',
        url: '/api/notifications/unread-count',
        headers: { authorization: `Bearer ${s.member.token}` },
      })
    ).json().count;
    expect(count).toBe(2);

    const list = await listNotifications(s.member.token);
    await inject({
      method: 'POST',
      url: `/api/notifications/${list[0].id}/read`,
      headers: { authorization: `Bearer ${s.member.token}` },
    });

    count = (
      await inject({
        method: 'GET',
        url: '/api/notifications/unread-count',
        headers: { authorization: `Bearer ${s.member.token}` },
      })
    ).json().count;
    expect(count).toBe(1);

    await inject({
      method: 'POST',
      url: '/api/notifications/read-all',
      headers: { authorization: `Bearer ${s.member.token}` },
    });

    count = (
      await inject({
        method: 'GET',
        url: '/api/notifications/unread-count',
        headers: { authorization: `Bearer ${s.member.token}` },
      })
    ).json().count;
    expect(count).toBe(0);
  });

  it("rejects markRead for someone else's notification id with 404", async () => {
    const s = await setupTeamWithMembers();
    await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks`,
      headers: { authorization: `Bearer ${s.owner.token}` },
      payload: { title: 'A', assigneeId: s.member.userId },
    });
    const memberInbox = await listNotifications(s.member.token);
    const memberNotifId = memberInbox[0].id;

    // Owner tries to mark member's notification read.
    const res = await inject({
      method: 'POST',
      url: `/api/notifications/${memberNotifId}/read`,
      headers: { authorization: `Bearer ${s.owner.token}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

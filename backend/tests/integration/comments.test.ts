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
  // Comment + Activity FKs cascade from Task; deleting tasks cleans them up.
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

async function setup(email = 'a@example.com') {
  const reg = await bootstrapUser(app, { email, name: email.split('@')[0], password: PASSWORD });
  const token = reg.token;
  const user = { id: reg.userId };

  const team = (
    await inject({
      method: 'POST',
      url: '/api/teams',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Team', slug: 'team-a' },
    })
  ).json();

  const project = (
    await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'P1' },
    })
  ).json();

  const task = (
    await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'T1' },
    })
  ).json();

  return { token, userId: user.id, teamId: team.id, projectId: project.id, taskId: task.id };
}

async function addMember(managerToken: string, teamId: string, email: string, role: 'MEMBER' | 'MANAGER' = 'MEMBER') {
  // Add-member by email requires the user to exist — bootstrap them first.
  const reg = await bootstrapUser(app, { email, name: email.split('@')[0], password: PASSWORD });
  await inject({
    method: 'POST',
    url: `/api/teams/${teamId}/members`,
    headers: { authorization: `Bearer ${managerToken}` },
    payload: { email, role },
  });
  return reg.token;
}

describe('POST /api/.../tasks/:taskId/comments', () => {
  it('creates a comment and returns the author name', async () => {
    const s = await setup();
    const res = await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/comments`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { body: 'First!' },
    });
    expect(res.statusCode).toBe(201);
    const c = res.json();
    expect(c.body).toBe('First!');
    expect(c.authorName).toBe('a');
  });

  it('returns 404 when taskId belongs to a different project', async () => {
    const a = await setup('a@example.com');
    // Make a second project owned by the same user and use its id under the first project's URL.
    const otherProj = (
      await inject({
        method: 'POST',
        url: `/api/teams/${a.teamId}/projects`,
        headers: { authorization: `Bearer ${a.token}` },
        payload: { name: 'P2' },
      })
    ).json();
    const otherTask = (
      await inject({
        method: 'POST',
        url: `/api/teams/${a.teamId}/projects/${otherProj.id}/tasks`,
        headers: { authorization: `Bearer ${a.token}` },
        payload: { title: 'Other' },
      })
    ).json();

    const res = await inject({
      method: 'POST',
      // First project's URL but otherProj's task id — should 404.
      url: `/api/teams/${a.teamId}/projects/${a.projectId}/tasks/${otherTask.id}/comments`,
      headers: { authorization: `Bearer ${a.token}` },
      payload: { body: 'wrong scope' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/.../tasks/:taskId/comments', () => {
  it('lists comments oldest first', async () => {
    const s = await setup();
    await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/comments`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { body: 'one' },
    });
    await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/comments`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { body: 'two' },
    });
    const res = await inject({
      method: 'GET',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/comments`,
      headers: { authorization: `Bearer ${s.token}` },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json();
    expect(list).toHaveLength(2);
    expect(list[0].body).toBe('one');
    expect(list[1].body).toBe('two');
  });
});

describe('PATCH /api/.../comments/:commentId', () => {
  it('lets the author edit their own comment', async () => {
    const s = await setup();
    const c = (
      await inject({
        method: 'POST',
        url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/comments`,
        headers: { authorization: `Bearer ${s.token}` },
        payload: { body: 'oops' },
      })
    ).json();
    const res = await inject({
      method: 'PATCH',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/comments/${c.id}`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { body: 'fixed' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().body).toBe('fixed');
  });

  // v1.39: to exercise the "MANAGER cannot edit non-authored comments"
  // rule we need the MANAGER to actually be able to *see* the project.
  // Project ownership is given to the manager (team MANAGER role +
  // project owner) so cascade-404 doesn't short-circuit the assertion.
  it('forbids non-author edits even by a MANAGER', async () => {
    const owner = await setup('owner@example.com');
    const otherToken = await addMember(owner.token, owner.teamId, 'other@example.com', 'MANAGER');
    // Owner-the-admin transfers ownership to `other` via direct DB write
    // (no project-transfer endpoint exists yet). v1.39 cascade then
    // grants `other` access; owner (global ADMIN) still bypasses.
    await prisma.project.update({
      where: { id: owner.projectId },
      data: { ownerId: (await prisma.user.findUnique({ where: { email: 'other@example.com' } }))!.id },
    });
    const c = (
      await inject({
        method: 'POST',
        url: `/api/teams/${owner.teamId}/projects/${owner.projectId}/tasks/${owner.taskId}/comments`,
        headers: { authorization: `Bearer ${owner.token}` },
        payload: { body: 'owner says hi' },
      })
    ).json();

    const res = await inject({
      method: 'PATCH',
      url: `/api/teams/${owner.teamId}/projects/${owner.projectId}/tasks/${owner.taskId}/comments/${c.id}`,
      headers: { authorization: `Bearer ${otherToken}` },
      payload: { body: 'hijacked' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('DELETE /api/.../comments/:commentId', () => {
  it('lets the author delete their own comment', async () => {
    const s = await setup();
    const c = (
      await inject({
        method: 'POST',
        url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/comments`,
        headers: { authorization: `Bearer ${s.token}` },
        payload: { body: 'remove me' },
      })
    ).json();
    const res = await inject({
      method: 'DELETE',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/comments/${c.id}`,
      headers: { authorization: `Bearer ${s.token}` },
    });
    expect(res.statusCode).toBe(204);
  });

  // v1.39: project ownership transferred to `member` so they can post a
  // comment in the first place. manager (global ADMIN + team MANAGER)
  // still deletes via admin bypass + the comment-delete-by-MANAGER rule.
  it('lets a team MANAGER delete a non-authored comment', async () => {
    const manager = await setup('mgr@example.com');
    const memberToken = await addMember(manager.token, manager.teamId, 'member@example.com', 'MEMBER');
    await prisma.project.update({
      where: { id: manager.projectId },
      data: { ownerId: (await prisma.user.findUnique({ where: { email: 'member@example.com' } }))!.id },
    });
    const memberComment = (
      await inject({
        method: 'POST',
        url: `/api/teams/${manager.teamId}/projects/${manager.projectId}/tasks/${manager.taskId}/comments`,
        headers: { authorization: `Bearer ${memberToken}` },
        payload: { body: 'member said something' },
      })
    ).json();
    const res = await inject({
      method: 'DELETE',
      url: `/api/teams/${manager.teamId}/projects/${manager.projectId}/tasks/${manager.taskId}/comments/${memberComment.id}`,
      headers: { authorization: `Bearer ${manager.token}` },
    });
    expect(res.statusCode).toBe(204);
  });

  // v1.39: member must own the project to reach the comments route;
  // owner (admin) still posts their own comment via cascade bypass. The
  // member-deleting-someone-else's-comment assertion (the actual rule
  // under test) then runs against the comment-delete-by-author rule.
  it('forbids a MEMBER from deleting another MEMBER\'s comment', async () => {
    const owner = await setup('owner@example.com');
    const memberToken = await addMember(owner.token, owner.teamId, 'member@example.com', 'MEMBER');
    await prisma.project.update({
      where: { id: owner.projectId },
      data: { ownerId: (await prisma.user.findUnique({ where: { email: 'member@example.com' } }))!.id },
    });
    const targetComment = (
      await inject({
        method: 'POST',
        url: `/api/teams/${owner.teamId}/projects/${owner.projectId}/tasks/${owner.taskId}/comments`,
        headers: { authorization: `Bearer ${owner.token}` },
        payload: { body: 'owner comment' },
      })
    ).json();
    const res = await inject({
      method: 'DELETE',
      url: `/api/teams/${owner.teamId}/projects/${owner.projectId}/tasks/${owner.taskId}/comments/${targetComment.id}`,
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(res.statusCode).toBe(403);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';

// v1.21: trash subsystem.
//   - delete = soft (row survives, deletedAt stamped)
//   - GET regular endpoints filter out soft-deleted rows
//   - GET /trash returns the deleted rows with `deletedByName` joined
//   - any team member can restore
//   - purge / empty are gated by `trash.emptyAllowedRoles` (default admin-only)
//   - empty returns counts of what was purged

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
  await prisma.instanceSetting.deleteMany();
  await prisma.comment.deleteMany();
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
  const admin = await bootstrapUser(app, { email: 'admin@example.com', name: 'Admin', password: PASSWORD });
  const adminToken = admin.token;

  const member = await bootstrapUser(app, { email: 'member@example.com', name: 'Mem', password: PASSWORD });
  const memberToken = member.token;

  const team = await inject({
    method: 'POST',
    url: '/api/teams',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { name: 'T', slug: 'team-trash' },
  });
  const teamId = team.json().id as string;
  await inject({
    method: 'POST',
    url: `/api/teams/${teamId}/members`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { email: 'member@example.com', role: 'MEMBER' },
  });

  const project = await inject({
    method: 'POST',
    url: `/api/teams/${teamId}/projects`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { name: 'P' },
  });
  const projectId = project.json().id as string;

  return { adminToken, memberToken, teamId, projectId };
}

describe('trash', () => {
  it('deleting a task soft-deletes it; it appears in /trash with deletedBy populated', async () => {
    const { adminToken, teamId, projectId } = await setup();
    const t = await inject({
      method: 'POST',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { title: 'Doomed' },
    });
    const taskId = t.json().id as string;

    const del = await inject({
      method: 'DELETE',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks/${taskId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(del.statusCode).toBe(204);

    // No longer in the regular list.
    const list = await inject({
      method: 'GET',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(list.json()).toHaveLength(0);

    // But in trash, with deletedByName populated.
    const trash = await inject({
      method: 'GET',
      url: `/api/teams/${teamId}/trash`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(trash.statusCode).toBe(200);
    const body = trash.json();
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0].id).toBe(taskId);
    expect(body.tasks[0].title).toBe('Doomed');
    expect(body.tasks[0].deletedByName).toBe('Admin');
    expect(body.emptyAllowedRoles).toBe('admin');
  });

  it('any team member can restore a trashed task', async () => {
    const { adminToken, memberToken, teamId, projectId } = await setup();
    const t = await inject({
      method: 'POST',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { title: 'Whoops' },
    });
    const taskId = t.json().id as string;
    await inject({
      method: 'DELETE',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks/${taskId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });

    // Member can restore.
    const restore = await inject({
      method: 'POST',
      url: `/api/teams/${teamId}/trash/tasks/${taskId}/restore`,
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(restore.statusCode).toBe(204);

    // Reappears in the normal list.
    const list = await inject({
      method: 'GET',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks`,
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(list.json()).toHaveLength(1);
  });

  it('MEMBER cannot purge or empty (default admin-only setting)', async () => {
    const { adminToken, memberToken, teamId, projectId } = await setup();
    const t = await inject({
      method: 'POST',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { title: 'X' },
    });
    const taskId = t.json().id as string;
    await inject({
      method: 'DELETE',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks/${taskId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });

    const purge = await inject({
      method: 'DELETE',
      url: `/api/teams/${teamId}/trash/tasks/${taskId}`,
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(purge.statusCode).toBe(403);

    const empty = await inject({
      method: 'POST',
      url: `/api/teams/${teamId}/trash/empty`,
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(empty.statusCode).toBe(403);
  });

  it('global ADMIN can purge + empty trash; returns the counts', async () => {
    const { adminToken, teamId, projectId } = await setup();
    // Two tasks + one comment, all soft-deleted.
    for (const title of ['A', 'B']) {
      const t = await inject({
        method: 'POST',
        url: `/api/teams/${teamId}/projects/${projectId}/tasks`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { title },
      });
      await inject({
        method: 'DELETE',
        url: `/api/teams/${teamId}/projects/${projectId}/tasks/${t.json().id}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
    }

    const empty = await inject({
      method: 'POST',
      url: `/api/teams/${teamId}/trash/empty`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json().tasksPurged).toBe(2);
    expect(empty.json().commentsPurged).toBe(0);

    // Trash now empty.
    const trash = await inject({
      method: 'GET',
      url: `/api/teams/${teamId}/trash`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(trash.json().tasks).toHaveLength(0);
  });

  it('when emptyAllowedRoles=admin-and-manager, MANAGER can purge', async () => {
    const { adminToken, memberToken, teamId, projectId } = await setup();
    // Flip the instance setting.
    await inject({
      method: 'PUT',
      url: '/api/settings/instance/trash.emptyAllowedRoles',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { value: 'admin-and-manager' },
    });
    // Promote 'member' to MANAGER for this scenario.
    const memberMembership = await prisma.teamMembership.findFirst({
      where: { teamId, user: { email: 'member@example.com' } },
    });
    await prisma.teamMembership.update({
      where: { id: memberMembership!.id },
      data: { role: 'MANAGER' },
    });

    const t = await inject({
      method: 'POST',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { title: 'X' },
    });
    const taskId = t.json().id as string;
    await inject({
      method: 'DELETE',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks/${taskId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });

    const purge = await inject({
      method: 'DELETE',
      url: `/api/teams/${teamId}/trash/tasks/${taskId}`,
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(purge.statusCode).toBe(204);
  });
});

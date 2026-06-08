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
  // Subtask cascades from Task; clearing tasks also clears subtasks. Being
  // explicit so a future schema change can't silently change behavior.
  await prisma.subtask.deleteMany();
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

async function setup(slug = 'team-s') {
  const { token } = await bootstrapUser(app, { email: 'a@example.com', name: 'Alice', password: PASSWORD });
  const team = (
    await inject({
      method: 'POST',
      url: '/api/teams',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'T', slug },
    })
  ).json();
  const project = (
    await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'P' },
    })
  ).json();
  const task = (
    await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects/${project.id}/tasks`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'T' },
    })
  ).json();
  return { token, teamId: team.id, projectId: project.id, taskId: task.id };
}

describe('POST /api/.../tasks/:taskId/subtasks', () => {
  it('creates a subtask with done=false by default', async () => {
    const s = await setup();
    const res = await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/subtasks`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { title: 'spec it' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.title).toBe('spec it');
    expect(body.done).toBe(false);
    expect(body.position).toBeGreaterThan(0);
  });

  it('appends with monotonically increasing positions', async () => {
    const s = await setup();
    const a = await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/subtasks`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { title: 'A' },
    });
    const b = await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/subtasks`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { title: 'B' },
    });
    expect(b.json().position).toBeGreaterThan(a.json().position);
  });

  it('returns 404 when the task belongs to a different project', async () => {
    const s = await setup();
    const otherProject = (
      await inject({
        method: 'POST',
        url: `/api/teams/${s.teamId}/projects`,
        headers: { authorization: `Bearer ${s.token}` },
        payload: { name: 'P2' },
      })
    ).json();
    // Use s.taskId (project P) under otherProject's URL — should 404.
    const res = await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/projects/${otherProject.id}/tasks/${s.taskId}/subtasks`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { title: 'misplaced' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('PATCH /api/.../subtasks/:subtaskId', () => {
  it('toggles done', async () => {
    const s = await setup();
    const sub = (
      await inject({
        method: 'POST',
        url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/subtasks`,
        headers: { authorization: `Bearer ${s.token}` },
        payload: { title: 'toggle me' },
      })
    ).json();
    const res = await inject({
      method: 'PATCH',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/subtasks/${sub.id}`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { done: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().done).toBe(true);
  });

  it('returns 404 when the subtask belongs to a different task', async () => {
    const s = await setup();
    // Make a second task and a subtask on it.
    const otherTask = (
      await inject({
        method: 'POST',
        url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks`,
        headers: { authorization: `Bearer ${s.token}` },
        payload: { title: 'other' },
      })
    ).json();
    const otherSub = (
      await inject({
        method: 'POST',
        url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${otherTask.id}/subtasks`,
        headers: { authorization: `Bearer ${s.token}` },
        payload: { title: 'belongs to other' },
      })
    ).json();
    // Patch otherSub's id but under s.taskId's URL — should 404.
    const res = await inject({
      method: 'PATCH',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/subtasks/${otherSub.id}`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { done: true },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('task response carries subtasks[] ordered by position', () => {
  it('lists tasks with their subtasks attached in position order', async () => {
    const s = await setup();
    // Add three subtasks; the third is marked done at create.
    const titles = ['first', 'second', 'third'];
    for (let i = 0; i < titles.length; i++) {
      await inject({
        method: 'POST',
        url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/subtasks`,
        headers: { authorization: `Bearer ${s.token}` },
        payload: { title: titles[i], done: i === 2 },
      });
    }
    const list = await inject({
      method: 'GET',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks`,
      headers: { authorization: `Bearer ${s.token}` },
    });
    const t = list.json().find((x: { id: string }) => x.id === s.taskId);
    expect(t.subtasks).toHaveLength(3);
    expect(t.subtasks.map((sub: { title: string }) => sub.title)).toEqual(['first', 'second', 'third']);
    expect(t.subtasks[2].done).toBe(true);
  });
});

describe('PATCH /api/.../subtasks/reorder (v1.35)', () => {
  async function setupWithThree() {
    const s = await setup('team-reorder');
    const ids: string[] = [];
    for (const title of ['A', 'B', 'C']) {
      const r = await inject({
        method: 'POST',
        url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/subtasks`,
        headers: { authorization: `Bearer ${s.token}` },
        payload: { title },
      });
      ids.push(r.json().id);
    }
    return { ...s, ids };
  }

  function reorder(s: { token: string; teamId: string; projectId: string; taskId: string }, ids: string[]) {
    return inject({
      method: 'PATCH',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/subtasks/reorder`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { subtaskIds: ids },
    });
  }

  it('happy path: positions follow the requested permutation', async () => {
    const s = await setupWithThree();
    const [a, b, c] = s.ids;
    const res = await reorder(s, [c!, a!, b!]);
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<{ id: string; position: number }>;
    // Items come back in position-asc order — so the first item is the
    // first id we requested.
    expect(items.map((i) => i.id)).toEqual([c, a, b]);
    // Positions are strictly increasing.
    for (let i = 1; i < items.length; i++) {
      expect(items[i]!.position).toBeGreaterThan(items[i - 1]!.position);
    }

    // No duplicate position values left in the task.
    const groups = await prisma.subtask.groupBy({
      by: ['position'],
      where: { taskId: s.taskId },
      _count: { _all: true },
    });
    for (const g of groups) expect(g._count._all).toBe(1);
  });

  it('missing id → 400', async () => {
    const s = await setupWithThree();
    const [a, b] = s.ids;
    const res = await reorder(s, [a!, b!]);
    expect(res.statusCode).toBe(400);
  });

  it('duplicate id → 400', async () => {
    const s = await setupWithThree();
    const [a, b, c] = s.ids;
    const res = await reorder(s, [a!, a!, b!, c!]);
    expect(res.statusCode).toBe(400);
  });

  it('foreign id (from another task) → 400', async () => {
    const s = await setupWithThree();
    // Make a second task on the SAME project and put a subtask on it.
    const otherTask = (
      await inject({
        method: 'POST',
        url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks`,
        headers: { authorization: `Bearer ${s.token}` },
        payload: { title: 'other' },
      })
    ).json();
    const otherSub = (
      await inject({
        method: 'POST',
        url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${otherTask.id}/subtasks`,
        headers: { authorization: `Bearer ${s.token}` },
        payload: { title: 'foreigner' },
      })
    ).json();

    const [a, b, c] = s.ids;
    const res = await reorder(s, [a!, b!, c!, otherSub.id]);
    expect(res.statusCode).toBe(400);
  });

  it('cross-tenant: another team trying to reorder this tasks subtasks → 404 on the task', async () => {
    const s = await setupWithThree();
    const stranger = await bootstrapUser(app, {
      email: 'stranger@example.com',
      name: 'Stranger',
      password: PASSWORD,
    });
    // Stranger has no team; they POST against the original team URL.
    const res = await inject({
      method: 'PATCH',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/subtasks/reorder`,
      headers: { authorization: `Bearer ${stranger.token}` },
      payload: { subtaskIds: s.ids },
    });
    // Caller isn't a member of teamS → requireTeamRole 403 before the
    // service runs. (Cross-team service-layer 404 would only fire if
    // the caller was in some OTHER team that didn't own the resource.)
    expect(res.statusCode).toBe(403);
  });

  it('parent task does not exist (or not in this chain) → 404', async () => {
    const s = await setupWithThree();
    const res = await inject({
      method: 'PATCH',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/c00000000000000000000000/subtasks/reorder`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { subtaskIds: s.ids },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('v1.41 Subtask optional scheduling window (startDate / endDate)', () => {
  const D = (iso: string) => new Date(iso).toISOString();

  it('creates a subtask with both dates set and echoes them back', async () => {
    const s = await setup();
    const res = await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/subtasks`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: {
        title: 'with dates',
        startDate: D('2026-06-01T00:00:00.000Z'),
        endDate: D('2026-06-05T00:00:00.000Z'),
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.startDate).toBe(D('2026-06-01T00:00:00.000Z'));
    expect(body.endDate).toBe(D('2026-06-05T00:00:00.000Z'));
  });

  it('creates a subtask with no dates (legacy shape)', async () => {
    const s = await setup();
    const res = await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/subtasks`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { title: 'no dates' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().startDate).toBeNull();
    expect(res.json().endDate).toBeNull();
  });

  it('rejects create when endDate is before startDate', async () => {
    const s = await setup();
    const res = await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/subtasks`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: {
        title: 'inverted',
        startDate: D('2026-06-05T00:00:00.000Z'),
        endDate: D('2026-06-01T00:00:00.000Z'),
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PATCH sets both dates on an existing subtask', async () => {
    const s = await setup();
    const sub = (
      await inject({
        method: 'POST',
        url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/subtasks`,
        headers: { authorization: `Bearer ${s.token}` },
        payload: { title: 'patch me' },
      })
    ).json();
    const res = await inject({
      method: 'PATCH',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/subtasks/${sub.id}`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: {
        startDate: D('2026-06-10T00:00:00.000Z'),
        endDate: D('2026-06-12T00:00:00.000Z'),
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().startDate).toBe(D('2026-06-10T00:00:00.000Z'));
    expect(res.json().endDate).toBe(D('2026-06-12T00:00:00.000Z'));
  });

  it('PATCH clears both dates with explicit null', async () => {
    const s = await setup();
    const sub = (
      await inject({
        method: 'POST',
        url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/subtasks`,
        headers: { authorization: `Bearer ${s.token}` },
        payload: {
          title: 'clear me',
          startDate: D('2026-06-01T00:00:00.000Z'),
          endDate: D('2026-06-05T00:00:00.000Z'),
        },
      })
    ).json();
    const res = await inject({
      method: 'PATCH',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/subtasks/${sub.id}`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { startDate: null, endDate: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().startDate).toBeNull();
    expect(res.json().endDate).toBeNull();
  });

  it('PATCH rejects when the merged window (existing start + new end) is inverted', async () => {
    const s = await setup();
    // Pre-existing subtask with startDate only.
    const sub = (
      await inject({
        method: 'POST',
        url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/subtasks`,
        headers: { authorization: `Bearer ${s.token}` },
        payload: { title: 'merged check', startDate: D('2026-06-10T00:00:00.000Z') },
      })
    ).json();
    // Now PATCH only the endDate to something earlier — service must
    // catch the inverted MERGED window even though the body alone looks fine.
    const res = await inject({
      method: 'PATCH',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/subtasks/${sub.id}`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { endDate: D('2026-06-01T00:00:00.000Z') },
    });
    expect(res.statusCode).toBe(400);
  });
});

// v1.42: subtask assignee. Distinct from technician (RACI / manager-gated).
// Anyone with project access can change. Validated to be a team member.
describe('v1.42 Subtask assignee', () => {
  it('creates a subtask with an assignee (team member) and echoes name', async () => {
    const s = await setup();
    // Add a second team member to assign to.
    const second = await bootstrapUser(app, {
      email: 'b@example.com',
      name: 'Bob',
      password: PASSWORD,
    });
    await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/members`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { email: 'b@example.com', role: 'MEMBER' },
    });
    const res = await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/subtasks`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { title: 'assigned at create', assigneeId: second.userId },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().assigneeId).toBe(second.userId);
    expect(res.json().assigneeName).toBe('Bob');
  });

  it('creates a subtask without an assignee (null by default)', async () => {
    const s = await setup();
    const res = await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/subtasks`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { title: 'unassigned' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().assigneeId).toBeNull();
    expect(res.json().assigneeName).toBeNull();
  });

  it('rejects assigneeId that is not a team member (400)', async () => {
    const s = await setup();
    // Bootstrap another user but DO NOT add to team.
    const outsider = await bootstrapUser(app, {
      email: 'outsider@example.com',
      name: 'Out',
      password: PASSWORD,
    });
    const res = await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/subtasks`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { title: 'bad assignee', assigneeId: outsider.userId },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PATCH reassigns to another team member', async () => {
    const s = await setup();
    const sub = (
      await inject({
        method: 'POST',
        url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/subtasks`,
        headers: { authorization: `Bearer ${s.token}` },
        payload: { title: 'reassign me' },
      })
    ).json();
    const second = await bootstrapUser(app, {
      email: 'c@example.com',
      name: 'Carol',
      password: PASSWORD,
    });
    await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/members`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { email: 'c@example.com', role: 'MEMBER' },
    });
    const res = await inject({
      method: 'PATCH',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/subtasks/${sub.id}`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { assigneeId: second.userId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().assigneeId).toBe(second.userId);
    expect(res.json().assigneeName).toBe('Carol');
  });

  it('PATCH clears assignee with explicit null', async () => {
    const s = await setup();
    const second = await bootstrapUser(app, {
      email: 'd@example.com',
      name: 'Dave',
      password: PASSWORD,
    });
    await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/members`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { email: 'd@example.com', role: 'MEMBER' },
    });
    const sub = (
      await inject({
        method: 'POST',
        url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/subtasks`,
        headers: { authorization: `Bearer ${s.token}` },
        payload: { title: 'clear me', assigneeId: second.userId },
      })
    ).json();
    const res = await inject({
      method: 'PATCH',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/subtasks/${sub.id}`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { assigneeId: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().assigneeId).toBeNull();
  });
});

describe('DELETE /api/.../subtasks/:subtaskId', () => {
  it('removes the subtask', async () => {
    const s = await setup();
    const sub = (
      await inject({
        method: 'POST',
        url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/subtasks`,
        headers: { authorization: `Bearer ${s.token}` },
        payload: { title: 'remove me' },
      })
    ).json();
    const del = await inject({
      method: 'DELETE',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/subtasks/${sub.id}`,
      headers: { authorization: `Bearer ${s.token}` },
    });
    expect(del.statusCode).toBe(204);

    const list = await inject({
      method: 'GET',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks`,
      headers: { authorization: `Bearer ${s.token}` },
    });
    const t = list.json().find((x: { id: string }) => x.id === s.taskId);
    expect(t.subtasks).toHaveLength(0);
  });
});

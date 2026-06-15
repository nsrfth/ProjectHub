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
    // TaskLabel + ProjectLabel rows cascade from Label; clearing tasks
    // and teams covers both — but be explicit so a future schema change can't
    // silently leak rows between tests.
    await prisma.projectLabel.deleteMany();
    await prisma.taskLabel.deleteMany();
  await prisma.label.deleteMany();
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

async function setup(slug = 'team-l') {
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

describe('POST /api/teams/:teamId/labels', () => {
  it('creates a label and rejects duplicate names within the team', async () => {
    const s = await setup();
    const r1 = await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/labels`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { name: 'bug', color: '#ff0000' },
    });
    expect(r1.statusCode).toBe(201);
    expect(r1.json().name).toBe('bug');

    const r2 = await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/labels`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { name: 'bug', color: '#0000ff' },
    });
    expect(r2.statusCode).toBe(409);
  });

  it('allows the same label name in a different team', async () => {
    const s = await setup('team-l-a');
    // Second team owned by the same user with a different slug.
    const teamB = (
      await inject({
        method: 'POST',
        url: '/api/teams',
        headers: { authorization: `Bearer ${s.token}` },
        payload: { name: 'B', slug: 'team-l-b' },
      })
    ).json();

    const r1 = await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/labels`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { name: 'bug', color: '#ff0000' },
    });
    const r2 = await inject({
      method: 'POST',
      url: `/api/teams/${teamB.id}/labels`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { name: 'bug', color: '#00ff00' },
    });
    expect(r1.statusCode).toBe(201);
    expect(r2.statusCode).toBe(201);
  });

  it('rejects bad color', async () => {
    const s = await setup();
    const res = await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/labels`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { name: 'bug', color: 'red' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('attach/detach', () => {
  it('attaches a label to a task and surfaces it in task response', async () => {
    const s = await setup();
    const label = (
      await inject({
        method: 'POST',
        url: `/api/teams/${s.teamId}/labels`,
        headers: { authorization: `Bearer ${s.token}` },
        payload: { name: 'urgent', color: '#ff8800' },
      })
    ).json();

    const att = await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/labels`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { labelId: label.id },
    });
    expect(att.statusCode).toBe(201);

    // Task GET (via list endpoint) should include the label.
    const list = await inject({
      method: 'GET',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks`,
      headers: { authorization: `Bearer ${s.token}` },
    });
    const t = list.json().find((x: { id: string }) => x.id === s.taskId);
    expect(t.labels).toHaveLength(1);
    expect(t.labels[0].name).toBe('urgent');
  });

  it('attach is idempotent — second attach returns 201 with same label', async () => {
    const s = await setup();
    const label = (
      await inject({
        method: 'POST',
        url: `/api/teams/${s.teamId}/labels`,
        headers: { authorization: `Bearer ${s.token}` },
        payload: { name: 'x', color: '#111111' },
      })
    ).json();
    const a1 = await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/labels`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { labelId: label.id },
    });
    const a2 = await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/labels`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { labelId: label.id },
    });
    expect(a1.statusCode).toBe(201);
    expect(a2.statusCode).toBe(201);
    expect(a2.json().id).toBe(label.id);
  });

  it('detach removes the label and the task response no longer carries it', async () => {
    const s = await setup();
    const label = (
      await inject({
        method: 'POST',
        url: `/api/teams/${s.teamId}/labels`,
        headers: { authorization: `Bearer ${s.token}` },
        payload: { name: 'tmp', color: '#222222' },
      })
    ).json();
    await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/labels`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { labelId: label.id },
    });

    const det = await inject({
      method: 'DELETE',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/labels/${label.id}`,
      headers: { authorization: `Bearer ${s.token}` },
    });
    expect(det.statusCode).toBe(204);

    const list = await inject({
      method: 'GET',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks`,
      headers: { authorization: `Bearer ${s.token}` },
    });
    const t = list.json().find((x: { id: string }) => x.id === s.taskId);
    expect(t.labels).toHaveLength(0);
  });

  it('returns 404 when attaching a label that belongs to a different team', async () => {
    const s = await setup('team-l-a');
    // Second team and a label inside it.
    const teamB = (
      await inject({
        method: 'POST',
        url: '/api/teams',
        headers: { authorization: `Bearer ${s.token}` },
        payload: { name: 'B', slug: 'team-l-b' },
      })
    ).json();
    const labelB = (
      await inject({
        method: 'POST',
        url: `/api/teams/${teamB.id}/labels`,
        headers: { authorization: `Bearer ${s.token}` },
        payload: { name: 'b-only', color: '#abcabc' },
      })
    ).json();
    // Attempt to attach team-B's label to a task in team-A.
    const att = await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/labels`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { labelId: labelB.id },
    });
    expect(att.statusCode).toBe(404);
  });
});

describe('DELETE /api/teams/:teamId/labels/:labelId', () => {
  it('cascade-detaches the label from every task it was on', async () => {
    const s = await setup();
    const label = (
      await inject({
        method: 'POST',
        url: `/api/teams/${s.teamId}/labels`,
        headers: { authorization: `Bearer ${s.token}` },
        payload: { name: 'temp', color: '#abcdef' },
      })
    ).json();
    await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${s.taskId}/labels`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { labelId: label.id },
    });
    // Deleting the label should detach it everywhere.
    const del = await inject({
      method: 'DELETE',
      url: `/api/teams/${s.teamId}/labels/${label.id}`,
      headers: { authorization: `Bearer ${s.token}` },
    });
    expect(del.statusCode).toBe(204);

    const list = await inject({
      method: 'GET',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks`,
      headers: { authorization: `Bearer ${s.token}` },
    });
    expect(list.json()[0].labels).toHaveLength(0);
  });
});

// v1.78.2: bulk attach at create time + replace-set on update via the
// task body's `labelIds` field. The per-id POST .../labels/:labelId and
// DELETE remain available for one-at-a-time edits from the LabelPicker.
describe('task body labelIds (v1.78.2)', () => {
  async function makeLabel(s: { token: string; teamId: string }, name: string, color = '#aabbcc') {
    const res = await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/labels`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { name, color },
    });
    return res.json() as { id: string; name: string; color: string };
  }

  it('attaches multiple labels at create time via labelIds[]', async () => {
    const s = await setup();
    const bug = await makeLabel(s, 'bug');
    const ux = await makeLabel(s, 'ux');
    const res = await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { title: 'Bulk labels', labelIds: [bug.id, ux.id] },
    });
    expect(res.statusCode).toBe(201);
    const labels = res.json().labels as Array<{ id: string; name: string }>;
    expect(labels.map((l) => l.id).sort()).toEqual([bug.id, ux.id].sort());
  });

  it('omitted labelIds creates a task with no labels (back-compat)', async () => {
    const s = await setup();
    await makeLabel(s, 'bug');
    const res = await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { title: 'No labels here' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().labels).toEqual([]);
  });

  it('rejects a labelId that belongs to a different team (400)', async () => {
    const s = await setup('team-l1');
    // Bootstrap a second team owned by a separate admin so its label
    // id is real but cross-team.
    const other = await bootstrapUser(app, {
      email: 'b@example.com',
      name: 'Bob',
      password: PASSWORD,
    });
    const otherTeam = (
      await inject({
        method: 'POST',
        url: '/api/teams',
        headers: { authorization: `Bearer ${other.token}` },
        payload: { name: 'OT', slug: 'other-team' },
      })
    ).json();
    const otherLabel = (
      await inject({
        method: 'POST',
        url: `/api/teams/${otherTeam.id}/labels`,
        headers: { authorization: `Bearer ${other.token}` },
        payload: { name: 'cross-team', color: '#ff0000' },
      })
    ).json();
    const res = await inject({
      method: 'POST',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { title: 'Sneak', labelIds: [otherLabel.id] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PATCH labelIds replaces the entire set (add + remove in one call)', async () => {
    const s = await setup();
    const bug = await makeLabel(s, 'bug');
    const ux = await makeLabel(s, 'ux');
    const docs = await makeLabel(s, 'docs');
    // Create with [bug, ux].
    const created = (
      await inject({
        method: 'POST',
        url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks`,
        headers: { authorization: `Bearer ${s.token}` },
        payload: { title: 'Replace me', labelIds: [bug.id, ux.id] },
      })
    ).json();
    // PATCH to [ux, docs] — bug should be removed, docs added, ux kept.
    const patched = await inject({
      method: 'PATCH',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${created.id}`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { labelIds: [ux.id, docs.id] },
    });
    expect(patched.statusCode).toBe(200);
    const ids = (patched.json().labels as Array<{ id: string }>).map((l) => l.id).sort();
    expect(ids).toEqual([docs.id, ux.id].sort());
  });

  it('PATCH labelIds=[] clears all labels (replace-set with empty array)', async () => {
    const s = await setup();
    const bug = await makeLabel(s, 'bug');
    const created = (
      await inject({
        method: 'POST',
        url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks`,
        headers: { authorization: `Bearer ${s.token}` },
        payload: { title: 'Will be empty', labelIds: [bug.id] },
      })
    ).json();
    const patched = await inject({
      method: 'PATCH',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${created.id}`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { labelIds: [] },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().labels).toEqual([]);
  });

  it('PATCH without labelIds leaves the existing labels intact', async () => {
    const s = await setup();
    const bug = await makeLabel(s, 'bug');
    const created = (
      await inject({
        method: 'POST',
        url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks`,
        headers: { authorization: `Bearer ${s.token}` },
        payload: { title: 'Keep labels', labelIds: [bug.id] },
      })
    ).json();
    // PATCH a different field; labels should NOT change.
    const patched = await inject({
      method: 'PATCH',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks/${created.id}`,
      headers: { authorization: `Bearer ${s.token}` },
      payload: { title: 'Renamed' },
    });
    expect(patched.statusCode).toBe(200);
    expect((patched.json().labels as Array<{ id: string }>).map((l) => l.id)).toEqual([bug.id]);
  });

  it('deletes a team label → it is detached from tasks (TaskLabel cascade)', async () => {
    const s = await setup();
    const bug = await makeLabel(s, 'bug');
    const ux = await makeLabel(s, 'ux');
    const created = (
      await inject({
        method: 'POST',
        url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks`,
        headers: { authorization: `Bearer ${s.token}` },
        payload: { title: 'Cascade me', labelIds: [bug.id, ux.id] },
      })
    ).json();
    // Delete `bug` at the team level — should cascade-detach from the task.
    const del = await inject({
      method: 'DELETE',
      url: `/api/teams/${s.teamId}/labels/${bug.id}`,
      headers: { authorization: `Bearer ${s.token}` },
    });
    expect(del.statusCode).toBe(204);
    // Re-fetch the task — only `ux` should remain; the task itself survives.
    const list = await inject({
      method: 'GET',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}/tasks`,
      headers: { authorization: `Bearer ${s.token}` },
    });
    const row = (list.json() as Array<{ id: string; labels: Array<{ id: string }> }>).find(
      (t) => t.id === created.id,
    );
    expect(row).toBeTruthy();
    expect(row!.labels.map((l) => l.id)).toEqual([ux.id]);
  });
});

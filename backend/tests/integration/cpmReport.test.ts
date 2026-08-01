import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';

// v2.23.0 (PMIS R5 supplement): CPM Schedule Analysis report — gating, auth
// cascade, float correctness, cache invalidation on reparent, and CSV export.

let app: FastifyInstance;

beforeAll(async () => {
  process.env.MASTER_KEY ??= '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
  app = await buildApp(loadEnv());
});
afterAll(async () => {
  if (app) await app.close();
});

beforeEach(async () => {
  await prisma.taskDependency.deleteMany();
  await prisma.task.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.rolePermission.deleteMany();
  await prisma.project.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.role.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
  await prisma.instanceSetting.deleteMany();
});

const PASSWORD = 'CorrectHorseBattery9';
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const day = (iso: string | null): string | null => (iso ? iso.slice(0, 10) : null);

async function register(email: string) {
  const r = await bootstrapUser(app, { email, password: PASSWORD });
  return { token: r.token, userId: r.userId };
}
async function createTeam(token: string, slug: string) {
  const r = await app.inject({
    method: 'POST', url: '/api/teams', headers: auth(token), payload: { name: slug, slug },
  });
  return r.json().id as string;
}
async function createProject(token: string, teamId: string, name: string) {
  const r = await app.inject({
    method: 'POST', url: `/api/teams/${teamId}/projects`, headers: auth(token), payload: { name },
  });
  return r.json().id as string;
}
async function enableCpm(token: string, teamId: string, projectId: string) {
  const r = await app.inject({
    method: 'PUT',
    url: `/api/teams/${teamId}/projects/${projectId}/profile/overrides`,
    headers: auth(token),
    payload: { overrides: { cpm_schedule: { enabled: true } } },
  });
  if (r.statusCode >= 300) throw new Error(r.body);
}
async function createTask(
  token: string, teamId: string, projectId: string, title: string,
  extra: Record<string, unknown> = {},
) {
  const r = await app.inject({
    method: 'POST',
    url: `/api/teams/${teamId}/projects/${projectId}/tasks`,
    headers: auth(token),
    payload: { title, ...extra },
  });
  if (r.statusCode !== 201) throw new Error(r.body);
  return r.json().id as string;
}
async function link(
  token: string, teamId: string, projectId: string, taskId: string, dependsOnId: string,
  extra: Record<string, unknown> = {},
) {
  const r = await app.inject({
    method: 'POST',
    url: `/api/teams/${teamId}/projects/${projectId}/tasks/${taskId}/dependencies`,
    headers: auth(token),
    payload: { dependsOnId, ...extra },
  });
  if (r.statusCode !== 201) throw new Error(r.body);
}
function cpmUrl(teamId: string, projectId: string, qs = '') {
  return `/api/teams/${teamId}/projects/${projectId}/reports/cpm${qs}`;
}
async function fetchCpm(token: string, teamId: string, projectId: string, qs = '') {
  return app.inject({ method: 'GET', url: cpmUrl(teamId, projectId, qs), headers: auth(token) });
}
const rowFor = (body: any, taskId: string) =>
  body.rows.find((r: any) => r.taskId === taskId);

/**
 * A -> B -> C finish-to-start chain plus an off-path activity D with slack.
 * The chain dates ABUT (each successor starts the day after its predecessor
 * finishes) so the chain carries zero float — leave a calendar gap anywhere in
 * it and that gap is genuine float, which is exactly what CPM should report.
 */
async function chainFixture(token: string, teamId: string, projectId: string) {
  const a = await createTask(token, teamId, projectId, 'Excavate', {
    startDate: '2026-06-01T00:00:00.000Z', dueDate: '2026-06-05T00:00:00.000Z',
  });
  const b = await createTask(token, teamId, projectId, 'Foundations', {
    startDate: '2026-06-06T00:00:00.000Z', dueDate: '2026-06-10T00:00:00.000Z',
  });
  const c = await createTask(token, teamId, projectId, 'Frame', {
    startDate: '2026-06-11T00:00:00.000Z', dueDate: '2026-06-15T00:00:00.000Z',
  });
  const d = await createTask(token, teamId, projectId, 'Site office', {
    startDate: '2026-06-01T00:00:00.000Z', dueDate: '2026-06-02T00:00:00.000Z',
  });
  await link(token, teamId, projectId, b, a);
  await link(token, teamId, projectId, c, b);
  return { a, b, c, d };
}

describe('CPM Schedule Analysis report', () => {
  it('gates the report behind the cpm_schedule module', async () => {
    const u = await register('a@example.com');
    const teamId = await createTeam(u.token, 'cpm-gate');
    const projectId = await createProject(u.token, teamId, 'P');

    const blocked = await fetchCpm(u.token, teamId, projectId);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('module_disabled');

    await enableCpm(u.token, teamId, projectId);
    const ok = await fetchCpm(u.token, teamId, projectId);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ projectId, basis: 'PLANNED' });
  });

  it('separates the driving chain from an activity with float', async () => {
    const u = await register('a@example.com');
    const teamId = await createTeam(u.token, 'cpm-float');
    const projectId = await createProject(u.token, teamId, 'P');
    await enableCpm(u.token, teamId, projectId);
    const { a, b, c, d } = await chainFixture(u.token, teamId, projectId);

    const res = await fetchCpm(u.token, teamId, projectId);
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // The chain drives the project finish; the standalone activity does not.
    expect(rowFor(body, a).floatStatus).toBe('CRITICAL');
    expect(rowFor(body, b).floatStatus).toBe('CRITICAL');
    expect(rowFor(body, c).floatStatus).toBe('CRITICAL');
    expect(rowFor(body, d).floatStatus).toBe('NORMAL');
    expect(rowFor(body, d).totalFloatDays).toBeGreaterThan(0);

    // Critical path in longest-path order, off-path activity absent.
    expect(body.criticalPath).toEqual([a, b, c]);
    expect(body.summary.projectFinish?.slice(0, 10)).toBe('2026-06-15');
    expect(body.summary.byFloatStatus).toMatchObject({ negative: 0, critical: 3, normal: 1 });

    // Driving predecessor is named for the successors, null for the chain head.
    expect(rowFor(body, b).drivingPredecessorId).toBe(a);
    expect(rowFor(body, c).drivingPredecessorId).toBe(b);
    expect(rowFor(body, a).drivingPredecessorId).toBeNull();
    expect(rowFor(body, d).drivingPredecessorId).toBeNull();
  });

  it('never reports negative float on a network whose stored dates satisfy every edge', async () => {
    const u = await register('a@example.com');
    const teamId = await createTeam(u.token, 'cpm-nonneg');
    const projectId = await createProject(u.token, teamId, 'P');
    await enableCpm(u.token, teamId, projectId);
    await chainFixture(u.token, teamId, projectId);

    const body = (await fetchCpm(u.token, teamId, projectId)).json();
    expect(body.rows.length).toBeGreaterThan(0);
    for (const r of body.rows) expect(r.totalFloatDays).toBeGreaterThanOrEqual(0);
    expect(body.summary.byFloatStatus.negative).toBe(0);
  });

  it('starts a successor the day after its predecessor finishes when the network drives', async () => {
    const u = await register('a@example.com');
    const teamId = await createTeam(u.token, 'cpm-fs');
    const projectId = await createProject(u.token, teamId, 'P');
    await enableCpm(u.token, teamId, projectId);
    // B is stored OVERLAPPING A — the FS edge must push it out, not let it sit
    // on A's finish date.
    const a = await createTask(u.token, teamId, projectId, 'A', {
      startDate: '2026-06-01T00:00:00.000Z', dueDate: '2026-06-05T00:00:00.000Z',
    });
    const b = await createTask(u.token, teamId, projectId, 'B', {
      startDate: '2026-06-03T00:00:00.000Z', dueDate: '2026-06-04T00:00:00.000Z',
    });
    await link(u.token, teamId, projectId, b, a);

    const body = (await fetchCpm(u.token, teamId, projectId)).json();
    expect(day(rowFor(body, a).earlyFinish)).toBe('2026-06-05');
    expect(day(rowFor(body, b).earlyStart)).toBe('2026-06-06');
    expect(rowFor(body, a).totalFloatDays).toBe(0);
    expect(rowFor(body, a).floatStatus).toBe('CRITICAL');
  });

  it('reports free float separately from total float', async () => {
    const u = await register('a@example.com');
    const teamId = await createTeam(u.token, 'cpm-ff');
    const projectId = await createProject(u.token, teamId, 'P');
    await enableCpm(u.token, teamId, projectId);
    const { d } = await chainFixture(u.token, teamId, projectId);
    const body = (await fetchCpm(u.token, teamId, projectId)).json();
    const row = rowFor(body, d);
    // A terminal activity's free float equals its total float.
    expect(row.freeFloatDays).toBe(row.totalFloatDays);
  });

  it('bands near-critical activities from the nearCriticalDays query param', async () => {
    const u = await register('a@example.com');
    const teamId = await createTeam(u.token, 'cpm-band');
    const projectId = await createProject(u.token, teamId, 'P');
    await enableCpm(u.token, teamId, projectId);
    const { d } = await chainFixture(u.token, teamId, projectId);

    const tight = (await fetchCpm(u.token, teamId, projectId, '?nearCriticalDays=0')).json();
    expect(tight.nearCriticalDays).toBe(0);
    expect(rowFor(tight, d).floatStatus).toBe('NORMAL');

    // D has 13 days of float — a wide band pulls it in without changing float.
    const wide = (await fetchCpm(u.token, teamId, projectId, '?nearCriticalDays=30')).json();
    expect(wide.nearCriticalDays).toBe(30);
    expect(rowFor(wide, d).floatStatus).toBe('NEAR_CRITICAL');
    expect(rowFor(wide, d).totalFloatDays).toBe(rowFor(tight, d).totalFloatDays);
  });

  it('rejects a nearCriticalDays above the cap', async () => {
    const u = await register('a@example.com');
    const teamId = await createTeam(u.token, 'cpm-cap');
    const projectId = await createProject(u.token, teamId, 'P');
    await enableCpm(u.token, teamId, projectId);
    const res = await fetchCpm(u.token, teamId, projectId, '?nearCriticalDays=999');
    expect(res.statusCode).toBe(400);
  });

  it('reports excluded activities instead of dropping them silently', async () => {
    const u = await register('a@example.com');
    const teamId = await createTeam(u.token, 'cpm-excl');
    const projectId = await createProject(u.token, teamId, 'P');
    await enableCpm(u.token, teamId, projectId);
    const a = await createTask(u.token, teamId, projectId, 'Dated', {
      startDate: '2026-06-01T00:00:00.000Z', dueDate: '2026-06-05T00:00:00.000Z',
    });
    const undated = await createTask(u.token, teamId, projectId, 'No dates yet');
    await link(u.token, teamId, projectId, undated, a);

    const body = (await fetchCpm(u.token, teamId, projectId)).json();
    expect(body.rows.map((r: any) => r.taskId)).toEqual([a]);
    const reasons = new Map(body.excluded.map((x: any) => [x.taskId, x.reason]));
    expect(reasons.get(undated)).toBe('NO_DATES');
    // The dated survivor lost a link — flagged so its float is not read as gospel.
    expect(body.excluded.some((x: any) => x.taskId === a && x.reason === 'ORPHANED_EDGE')).toBe(true);
    expect(body.excluded.find((x: any) => x.taskId === undated).title).toBe('No dates yet');
    expect(body.summary.excludedCount).toBe(body.excluded.length);
  });

  it('excludes WBS summary tasks and carries the outline code on the leaves', async () => {
    const u = await register('a@example.com');
    const teamId = await createTeam(u.token, 'cpm-wbs');
    const projectId = await createProject(u.token, teamId, 'P');
    await enableCpm(u.token, teamId, projectId);
    const parent = await createTask(u.token, teamId, projectId, 'Phase 1', {
      startDate: '2026-06-01T00:00:00.000Z', dueDate: '2026-06-30T00:00:00.000Z',
    });
    const child = await createTask(u.token, teamId, projectId, 'Leaf', {
      startDate: '2026-06-01T00:00:00.000Z', dueDate: '2026-06-05T00:00:00.000Z',
      parentId: parent,
    });

    const body = (await fetchCpm(u.token, teamId, projectId)).json();
    expect(body.rows.map((r: any) => r.taskId)).toEqual([child]);
    expect(body.excluded).toContainEqual({ taskId: parent, title: 'Phase 1', reason: 'IS_SUMMARY' });
    // Outline code matches what the WBS view derives for the same task.
    const wbs = await app.inject({
      method: 'GET',
      url: `/api/teams/${teamId}/projects/${projectId}/wbs`,
      headers: auth(u.token),
    });
    expect(wbs.statusCode).toBe(200);
    const node = wbs.json().items.find((n: any) => n.id === child);
    expect(rowFor(body, child).wbsCode).toBe(node.wbsCode);
  });

  // §3.3 / acceptance 4 — reparenting alone must change the answer.
  it('recomputes after a reparent with no other schedule edit', async () => {
    const u = await register('a@example.com');
    const teamId = await createTeam(u.token, 'cpm-move');
    const projectId = await createProject(u.token, teamId, 'P');
    await enableCpm(u.token, teamId, projectId);
    const holder = await createTask(u.token, teamId, projectId, 'Holder', {
      startDate: '2026-06-01T00:00:00.000Z', dueDate: '2026-06-30T00:00:00.000Z',
    });
    const leaf = await createTask(u.token, teamId, projectId, 'Leaf', {
      startDate: '2026-06-01T00:00:00.000Z', dueDate: '2026-06-05T00:00:00.000Z',
    });

    // Both are roots and both are leaves → both are in the network.
    const before = (await fetchCpm(u.token, teamId, projectId)).json();
    expect(before.rows.map((r: any) => r.taskId).sort()).toEqual([holder, leaf].sort());
    expect(before.excluded).toEqual([]);

    // Reparent the leaf under the holder. The holder becomes a summary and must
    // leave the network — with no dependency or date edit anywhere.
    const moved = await app.inject({
      method: 'POST',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks/${leaf}/move`,
      headers: auth(u.token),
      payload: { newParentId: holder, position: 0 },
    });
    expect(moved.statusCode).toBe(200);

    const after = (await fetchCpm(u.token, teamId, projectId)).json();
    expect(after.scheduleVersion).toBeGreaterThan(before.scheduleVersion);
    expect(after.rows.map((r: any) => r.taskId)).toEqual([leaf]);
    expect(after.excluded).toContainEqual({ taskId: holder, title: 'Holder', reason: 'IS_SUMMARY' });
  });

  it('recomputes after a soft delete', async () => {
    const u = await register('a@example.com');
    const teamId = await createTeam(u.token, 'cpm-del');
    const projectId = await createProject(u.token, teamId, 'P');
    await enableCpm(u.token, teamId, projectId);
    const keep = await createTask(u.token, teamId, projectId, 'Keep', {
      startDate: '2026-06-01T00:00:00.000Z', dueDate: '2026-06-05T00:00:00.000Z',
    });
    const drop = await createTask(u.token, teamId, projectId, 'Drop', {
      startDate: '2026-06-01T00:00:00.000Z', dueDate: '2026-06-20T00:00:00.000Z',
    });

    const before = (await fetchCpm(u.token, teamId, projectId)).json();
    expect(before.rows).toHaveLength(2);
    expect(before.summary.projectFinish?.slice(0, 10)).toBe('2026-06-20');

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks/${drop}`,
      headers: auth(u.token),
    });
    expect(del.statusCode).toBeLessThan(300);

    const after = (await fetchCpm(u.token, teamId, projectId)).json();
    expect(after.scheduleVersion).toBeGreaterThan(before.scheduleVersion);
    expect(after.rows.map((r: any) => r.taskId)).toEqual([keep]);
    expect(after.summary.projectFinish?.slice(0, 10)).toBe('2026-06-05');
  });

  it('surfaces a cyclic network as DEPENDENCY_CYCLE', async () => {
    const u = await register('a@example.com');
    const teamId = await createTeam(u.token, 'cpm-cycle');
    const projectId = await createProject(u.token, teamId, 'P');
    await enableCpm(u.token, teamId, projectId);
    const t1 = await createTask(u.token, teamId, projectId, 'A', {
      startDate: '2026-06-01T00:00:00.000Z', dueDate: '2026-06-02T00:00:00.000Z',
    });
    const t2 = await createTask(u.token, teamId, projectId, 'B', {
      startDate: '2026-06-03T00:00:00.000Z', dueDate: '2026-06-04T00:00:00.000Z',
    });
    await link(u.token, teamId, projectId, t2, t1);
    // The dependency API blocks the closing edge, so plant it directly to
    // exercise the engine's own cycle guard.
    const t1Row = await prisma.task.findUnique({ where: { id: t1 }, select: { teamId: true } });
    await prisma.taskDependency.create({
      data: { taskId: t1, dependsOnId: t2, teamId: t1Row!.teamId, type: 'FINISH_TO_START' },
    });

    const res = await fetchCpm(u.token, teamId, projectId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('DEPENDENCY_CYCLE');
  });

  it("denies another team's member", async () => {
    const owner = await register('owner@example.com');
    const teamId = await createTeam(owner.token, 'cpm-tenant-a');
    const projectId = await createProject(owner.token, teamId, 'P');
    await enableCpm(owner.token, teamId, projectId);
    await chainFixture(owner.token, teamId, projectId);

    const outsider = await register('outsider@example.com');
    await createTeam(outsider.token, 'cpm-tenant-b');
    const res = await fetchCpm(outsider.token, teamId, projectId);
    expect([403, 404]).toContain(res.statusCode);
    expect(res.body).not.toContain('Excavate');
  });

  it('exports CSV with a BOM and non-ASCII activity names intact', async () => {
    const u = await register('a@example.com');
    const teamId = await createTeam(u.token, 'cpm-csv');
    const projectId = await createProject(u.token, teamId, 'P');
    await enableCpm(u.token, teamId, projectId);
    await createTask(u.token, teamId, projectId, 'خاکبرداری', {
      startDate: '2026-06-01T00:00:00.000Z', dueDate: '2026-06-05T00:00:00.000Z',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/teams/${teamId}/projects/${projectId}/reports/cpm.csv`,
      headers: auth(u.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(String(res.headers['content-disposition'])).toContain('attachment');
    expect(res.body.startsWith('﻿')).toBe(true);
    expect(res.body).toContain('خاکبرداری');
    expect(res.body).toContain('Total Float (d)');
    expect(res.body).toContain('Free Float (d)');
  });

  it('gates the CSV export behind the module too', async () => {
    const u = await register('a@example.com');
    const teamId = await createTeam(u.token, 'cpm-csv-gate');
    const projectId = await createProject(u.token, teamId, 'P');
    const res = await app.inject({
      method: 'GET',
      url: `/api/teams/${teamId}/projects/${projectId}/reports/cpm.csv`,
      headers: auth(u.token),
    });
    expect(res.statusCode).toBe(403);
  });

  it('leaves the Gantt critical-path overlay contract unchanged', async () => {
    const u = await register('a@example.com');
    const teamId = await createTeam(u.token, 'cpm-gantt');
    const projectId = await createProject(u.token, teamId, 'P');
    await enableCpm(u.token, teamId, projectId);
    const { a } = await chainFixture(u.token, teamId, projectId);

    const res = await app.inject({
      method: 'GET',
      url: `/api/teams/${teamId}/projects/${projectId}/reports/gantt?include=criticalPath`,
      headers: auth(u.token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.criticalChain)).toBe(true);
    expect(body.criticalChain).toContain(a);
    const overlay = body.tasks.find((t: any) => t.id === a);
    // The overlay still sees exactly the fields it always did — the new engine
    // outputs are stripped by the Gantt response schema.
    expect(Object.keys(overlay.cpm).sort()).toEqual(
      ['earlyFinish', 'earlyStart', 'isCritical', 'lateFinish', 'lateStart', 'taskId', 'totalFloatDays'],
    );
  });
});

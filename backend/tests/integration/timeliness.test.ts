import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';

// Integration coverage for GET /reports/timeliness. Asserts on-time rate,
// avg variance, evaluated count, and behind-plan count under five
// deliberately-shaped fixtures.

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

async function registerUser(email: string): Promise<string> {
  const r = await bootstrapUser(app, { email, name: email.split('@')[0], password: PASSWORD });
  return r.token;
}

async function setupTeam(): Promise<{ token: string; teamId: string; projectId: string }> {
  const token = await registerUser('owner@example.com');
  const tRes = await inject({
    method: 'POST',
    url: '/api/teams',
    headers: { authorization: `Bearer ${token}` },
    payload: { name: 'TimeTeam', slug: 'time-team' },
  });
  if (tRes.statusCode !== 201) {
    throw new Error(`createTeam failed: ${tRes.statusCode} ${tRes.body}`);
  }
  const teamId = tRes.json().id as string;
  const pRes = await inject({
    method: 'POST',
    url: `/api/teams/${teamId}/projects`,
    headers: { authorization: `Bearer ${token}` },
    payload: { name: 'P' },
  });
  if (pRes.statusCode !== 201) {
    throw new Error(`createProject failed: ${pRes.statusCode} ${pRes.body}`);
  }
  const projectId = pRes.json().id as string;
  return { token, teamId, projectId };
}

// Bypass the controller to insert tasks with the exact shape we want — the API
// auto-fills completedAt on status=DONE which would fight the fixture. Going
// through Prisma keeps the test focused on the *report*, not task creation.
async function insertTask(
  projectId: string,
  teamId: string,
  creatorId: string,
  data: {
    status: 'TODO' | 'IN_PROGRESS' | 'REVIEW' | 'DONE';
    plannedDate: Date | null;
    completedAt: Date | null;
  },
): Promise<void> {
  await prisma.task.create({
    data: {
      projectId,
      teamId,
      creatorId,
      title: 'fixture',
      status: data.status,
      plannedDate: data.plannedDate,
      completedAt: data.completedAt,
    },
  });
}

function day(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d));
}

async function fetchTimeliness(
  token: string,
  teamId: string,
  days = 7,
): Promise<{
  windowDays: number;
  evaluatedCount: number;
  onTimeRate: number;
  avgVarianceDays: number;
  behindPlanCount: number;
}> {
  const res = await inject({
    method: 'GET',
    url: `/api/teams/${teamId}/reports/timeliness?days=${days}`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

describe('GET /api/teams/:teamId/reports/timeliness', () => {
  it('returns zeros when no task has both plannedDate and completedAt', async () => {
    const { token, teamId } = await setupTeam();
    const r = await fetchTimeliness(token, teamId);
    expect(r).toMatchObject({
      windowDays: 7,
      evaluatedCount: 0,
      onTimeRate: 0,
      avgVarianceDays: 0,
      behindPlanCount: 0,
    });
  });

  it('counts a task as on-time when completedAt <= plannedDate', async () => {
    const { token, teamId, projectId } = await setupTeam();
    const me = (await prisma.user.findFirst())!;
    // Recent enough to fall inside the default 7-day window.
    const today = new Date();
    const twoDaysAgo = new Date(today.getTime() - 2 * 86_400_000);
    await insertTask(projectId, teamId, me.id, {
      status: 'DONE',
      plannedDate: today,
      completedAt: twoDaysAgo, // 2 days early → on-time
    });
    const r = await fetchTimeliness(token, teamId);
    expect(r.evaluatedCount).toBe(1);
    expect(r.onTimeRate).toBe(1);
    expect(r.avgVarianceDays).toBeCloseTo(-2, 2);
    expect(r.behindPlanCount).toBe(0);
  });

  it('computes a mixed on-time rate and signed avg variance across late + early + exact', async () => {
    const { token, teamId, projectId } = await setupTeam();
    const me = (await prisma.user.findFirst())!;
    const now = new Date();
    const t = (deltaDays: number) => new Date(now.getTime() + deltaDays * 86_400_000);
    // 4 completed tasks in window with variances: +1, -2, 0, +3
    // expected: 2/4 on-time = 0.5; avg = (1 - 2 + 0 + 3) / 4 = 0.5
    await insertTask(projectId, teamId, me.id, {
      status: 'DONE', plannedDate: t(-3), completedAt: t(-2), // +1d late
    });
    await insertTask(projectId, teamId, me.id, {
      status: 'DONE', plannedDate: t(-1), completedAt: t(-3), // -2d early
    });
    await insertTask(projectId, teamId, me.id, {
      status: 'DONE', plannedDate: t(-2), completedAt: t(-2), // 0d exact
    });
    await insertTask(projectId, teamId, me.id, {
      status: 'DONE', plannedDate: t(-4), completedAt: t(-1), // +3d late
    });
    const r = await fetchTimeliness(token, teamId);
    expect(r.evaluatedCount).toBe(4);
    expect(r.onTimeRate).toBeCloseTo(0.5, 5);
    expect(r.avgVarianceDays).toBeCloseTo(0.5, 5);
  });

  it('excludes tasks completed outside the trailing window', async () => {
    const { token, teamId, projectId } = await setupTeam();
    const me = (await prisma.user.findFirst())!;
    const now = new Date();
    const t = (deltaDays: number) => new Date(now.getTime() + deltaDays * 86_400_000);
    // Inside 7d, late by 1.
    await insertTask(projectId, teamId, me.id, {
      status: 'DONE', plannedDate: t(-3), completedAt: t(-2),
    });
    // Outside 7d (45 days back), would be on-time if counted.
    await insertTask(projectId, teamId, me.id, {
      status: 'DONE', plannedDate: t(-44), completedAt: t(-45),
    });
    const r7 = await fetchTimeliness(token, teamId, 7);
    expect(r7.evaluatedCount).toBe(1);
    expect(r7.onTimeRate).toBe(0); // 0/1
    const r60 = await fetchTimeliness(token, teamId, 60);
    expect(r60.evaluatedCount).toBe(2);
    expect(r60.onTimeRate).toBeCloseTo(0.5, 5);
  });

  it('counts behindPlan only for OPEN tasks with plannedDate in the past', async () => {
    const { token, teamId, projectId } = await setupTeam();
    const me = (await prisma.user.findFirst())!;
    const now = new Date();
    const t = (deltaDays: number) => new Date(now.getTime() + deltaDays * 86_400_000);
    // Behind plan: open + planned in past.
    await insertTask(projectId, teamId, me.id, {
      status: 'TODO', plannedDate: t(-3), completedAt: null,
    });
    await insertTask(projectId, teamId, me.id, {
      status: 'IN_PROGRESS', plannedDate: t(-1), completedAt: null,
    });
    await insertTask(projectId, teamId, me.id, {
      status: 'REVIEW', plannedDate: t(-5), completedAt: null,
    });
    // Not behind: open but planned in future.
    await insertTask(projectId, teamId, me.id, {
      status: 'TODO', plannedDate: t(+2), completedAt: null,
    });
    // Not counted: DONE in the past — already resolved, even if late.
    await insertTask(projectId, teamId, me.id, {
      status: 'DONE', plannedDate: t(-2), completedAt: t(-1),
    });
    // Not counted: no planned date.
    await insertTask(projectId, teamId, me.id, {
      status: 'TODO', plannedDate: null, completedAt: null,
    });
    const r = await fetchTimeliness(token, teamId);
    expect(r.behindPlanCount).toBe(3);
  });
});

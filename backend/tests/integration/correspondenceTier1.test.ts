import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';

// W2.2: correspondence Tier-1 — external ref/date, reply-to (same-project),
// referral dueAt, letter↔task bridge, and the cross-project me/referrals inbox.

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
  if (app) await app.close();
});

beforeEach(async () => {
  await prisma.refreshToken.deleteMany();
  await prisma.correspondenceTask.deleteMany();
  await prisma.correspondenceReferral.deleteMany();
  await prisma.correspondence.deleteMany();
  await prisma.correspondenceCounter.deleteMany();
  await prisma.contact.deleteMany();
  await prisma.task.deleteMany();
  await prisma.project.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
});

const PASSWORD = 'CorrectHorseBattery9';
const H = (t: string) => ({ authorization: `Bearer ${t}` });
const DATE_1404 = '2025-06-21T00:00:00.000Z';

function inject(opts: Parameters<FastifyInstance['inject']>[0]) {
  return app.inject(opts);
}

async function createTeam(token: string, slug: string): Promise<string> {
  return (await inject({ method: 'POST', url: '/api/teams', headers: H(token), payload: { name: slug, slug } })).json().id;
}
async function createProject(token: string, teamId: string, name: string): Promise<string> {
  return (await inject({ method: 'POST', url: `/api/teams/${teamId}/projects`, headers: H(token), payload: { name } })).json().id;
}
async function enableModule(adminToken: string, projectId: string) {
  return inject({ method: 'PATCH', url: `/api/admin/correspondence/projects/${projectId}`, headers: H(adminToken), payload: { enabled: true } });
}
function base(teamId: string, projectId: string) {
  return `/api/teams/${teamId}/projects/${projectId}/correspondence`;
}
async function createLetter(token: string, teamId: string, projectId: string, payload: Record<string, unknown>) {
  return inject({ method: 'POST', url: base(teamId, projectId), headers: H(token), payload: { direction: 'INCOMING', subject: 'L', letterDate: DATE_1404, ...payload } });
}

describe('W2.2 external ref/date + reply-to', () => {
  it('round-trips external ref/date and a same-project reply-to with parent summary', async () => {
    const a = await bootstrapUser(app, { email: 'a@ex.com', password: PASSWORD });
    const teamId = await createTeam(a.token, 't-a');
    const projectId = await createProject(a.token, teamId, 'P');
    await enableModule(a.token, projectId);

    const parent = await createLetter(a.token, teamId, projectId, { subject: 'Original' });
    expect(parent.statusCode).toBe(201);
    const parentId = parent.json().id;

    const reply = await createLetter(a.token, teamId, projectId, {
      subject: 'Reply',
      externalReferenceNumber: 'NIOC-2025-42',
      externalDate: DATE_1404,
      replyToId: parentId,
    });
    expect(reply.statusCode).toBe(201);
    const rid = reply.json().id;

    const got = (await inject({ method: 'GET', url: `${base(teamId, projectId)}/${rid}`, headers: H(a.token) })).json();
    expect(got.externalReferenceNumber).toBe('NIOC-2025-42');
    expect(got.externalDate).toBe(DATE_1404);
    expect(got.replyToId).toBe(parentId);
    expect(got.replyTo).toMatchObject({ id: parentId, subject: 'Original' });
  });

  it('rejects a reply-to that lives in a different project (400)', async () => {
    const a = await bootstrapUser(app, { email: 'a@ex.com', password: PASSWORD });
    const teamId = await createTeam(a.token, 't-a');
    const p1 = await createProject(a.token, teamId, 'P1');
    const p2 = await createProject(a.token, teamId, 'P2');
    await enableModule(a.token, p1);
    await enableModule(a.token, p2);

    const inP1 = await createLetter(a.token, teamId, p1, { subject: 'In P1' });
    const crossed = await createLetter(a.token, teamId, p2, { subject: 'Bad reply', replyToId: inP1.json().id });
    expect(crossed.statusCode).toBe(400);
    expect(crossed.json().error.code).toBe('CORRESPONDENCE_REPLY_TO_INVALID');
  });
});

describe('W2.2 letter↔task bridge', () => {
  it('creates and links a task in the letter project, then lists it', async () => {
    const a = await bootstrapUser(app, { email: 'a@ex.com', password: PASSWORD });
    const teamId = await createTeam(a.token, 't-a');
    const projectId = await createProject(a.token, teamId, 'P');
    await enableModule(a.token, projectId);
    const letter = await createLetter(a.token, teamId, projectId, {});
    const id = letter.json().id;

    const linked = await inject({
      method: 'POST',
      url: `${base(teamId, projectId)}/${id}/tasks`,
      headers: H(a.token),
      payload: { title: 'Draft the response', priority: 'HIGH' },
    });
    expect(linked.statusCode).toBe(201);
    expect(linked.json().items).toHaveLength(1);
    expect(linked.json().items[0].title).toBe('Draft the response');

    const list = await inject({ method: 'GET', url: `${base(teamId, projectId)}/${id}/tasks`, headers: H(a.token) });
    expect(list.json().items).toHaveLength(1);

    // The linked task actually exists in the project.
    const count = await prisma.task.count({ where: { projectId, title: 'Draft the response' } });
    expect(count).toBe(1);
  });

  it('cross-team caller cannot link a task (opaque 404/403)', async () => {
    const a = await bootstrapUser(app, { email: 'a@ex.com', password: PASSWORD });
    const b = await bootstrapUser(app, { email: 'b@ex.com', password: PASSWORD, globalRole: 'MEMBER' });
    const teamId = await createTeam(a.token, 't-a');
    const projectId = await createProject(a.token, teamId, 'P');
    await enableModule(a.token, projectId);
    const id = (await createLetter(a.token, teamId, projectId, {})).json().id;

    const res = await inject({
      method: 'POST',
      url: `${base(teamId, projectId)}/${id}/tasks`,
      headers: H(b.token),
      payload: { title: 'x' },
    });
    expect([403, 404]).toContain(res.statusCode);
  });
});

describe('W2.2 me/referrals inbox', () => {
  it('is user-scoped + team-scoped, excludes soft-deleted letters, and filters overdue', async () => {
    const a = await bootstrapUser(app, { email: 'a@ex.com', password: PASSWORD }); // global ADMIN
    const b = await bootstrapUser(app, { email: 'b@ex.com', password: PASSWORD, globalRole: 'MEMBER' });

    const teamA = await createTeam(a.token, 't-a');
    const projA = await createProject(a.token, teamA, 'PA');
    await enableModule(a.token, projA);

    // b owns their own team; a (global admin) enables the module there.
    const teamB = await createTeam(b.token, 't-b');
    const projB = await createProject(b.token, teamB, 'PB');
    await enableModule(a.token, projB);

    // Letter in A, referred to A with a PAST due date.
    const la = (await createLetter(a.token, teamA, projA, {})).json().id;
    await inject({
      method: 'POST',
      url: `${base(teamA, projA)}/${la}/referrals`,
      headers: H(a.token),
      payload: { targets: [{ userId: a.userId, kind: 'ACTION', dueAt: '2020-01-01T00:00:00.000Z' }] },
    });

    // Letter in B, referred to B.
    const lb = (await createLetter(b.token, teamB, projB, {})).json().id;
    await inject({
      method: 'POST',
      url: `${base(teamB, projB)}/${lb}/referrals`,
      headers: H(b.token),
      payload: { targets: [{ userId: b.userId, kind: 'ACTION' }] },
    });

    // a sees only their own referral (team A), never b's.
    const aInbox = (await inject({ method: 'GET', url: '/api/me/referrals', headers: H(a.token) })).json();
    expect(aInbox.items).toHaveLength(1);
    expect(aInbox.items[0].correspondenceId).toBe(la);
    expect(aInbox.items[0].teamId).toBe(teamA);
    expect(aInbox.items[0].dueAt).toBe('2020-01-01T00:00:00.000Z');

    // b sees only their own.
    const bInbox = (await inject({ method: 'GET', url: '/api/me/referrals', headers: H(b.token) })).json();
    expect(bInbox.items).toHaveLength(1);
    expect(bInbox.items[0].correspondenceId).toBe(lb);

    // overdue filter catches a's past-due referral.
    const overdue = (await inject({ method: 'GET', url: '/api/me/referrals?due=overdue', headers: H(a.token) })).json();
    expect(overdue.items).toHaveLength(1);

    // Soft-delete letter A → its referral drops out of a's inbox.
    await inject({ method: 'DELETE', url: `${base(teamA, projA)}/${la}`, headers: H(a.token) });
    const afterDelete = (await inject({ method: 'GET', url: '/api/me/referrals', headers: H(a.token) })).json();
    expect(afterDelete.items).toHaveLength(0);
  });
});

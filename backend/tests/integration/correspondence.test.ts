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
  await prisma.notification.deleteMany();
  await prisma.attachment.deleteMany();
  // Referrals + counters + correspondence cascade from project/team deletes,
  // but clear explicitly so a leftover row from a failed test can't bleed.
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

function inject(opts: Parameters<FastifyInstance['inject']>[0]) {
  return app.inject(opts);
}
const H = (token: string) => ({ authorization: `Bearer ${token}` });
const PASSWORD = 'CorrectHorseBattery9';

// 1404-03-31 ≈ 2025-06-21 (UTC midnight). Jalali year 1404.
const DATE_1404 = '2025-06-21T00:00:00.000Z';
// 1405-01-01 ≈ 2026-03-21. Jalali year 1405 (counter resets).
const DATE_1405 = '2026-03-21T00:00:00.000Z';

async function setup(email = 'admin@example.com', slug = 'team-a') {
  // First bootstrapped user is global ADMIN — can hit the admin enablement API.
  const reg = await bootstrapUser(app, { email, name: email.split('@')[0], password: PASSWORD });
  const team = (
    await inject({ method: 'POST', url: '/api/teams', headers: H(reg.token), payload: { name: 'Team', slug } })
  ).json();
  const project = (
    await inject({
      method: 'POST',
      url: `/api/teams/${team.id}/projects`,
      headers: H(reg.token),
      payload: { name: 'P1' },
    })
  ).json();
  return { token: reg.token, userId: reg.userId, teamId: team.id, projectId: project.id };
}

async function enableModule(adminToken: string, projectId: string) {
  return inject({
    method: 'PATCH',
    url: `/api/admin/correspondence/projects/${projectId}`,
    headers: H(adminToken),
    payload: { enabled: true },
  });
}

async function addMember(
  managerToken: string,
  teamId: string,
  email: string,
  role: 'MEMBER' | 'MANAGER' = 'MEMBER',
) {
  const reg = await bootstrapUser(app, { email, name: email.split('@')[0], password: PASSWORD });
  await inject({
    method: 'POST',
    url: `/api/teams/${teamId}/members`,
    headers: H(managerToken),
    payload: { email, role },
  });
  return { token: reg.token, userId: reg.userId };
}

function base(s: { teamId: string; projectId: string }) {
  return `/api/teams/${s.teamId}/projects/${s.projectId}/correspondence`;
}

describe('correspondence module enablement gate', () => {
  it('404s when the module is disabled, works once admin enables it', async () => {
    const s = await setup();

    const before = await inject({ method: 'GET', url: base(s), headers: H(s.token) });
    expect(before.statusCode).toBe(404);

    const en = await enableModule(s.token, s.projectId);
    expect(en.statusCode).toBe(200);
    expect(en.json().correspondenceEnabled).toBe(true);

    const after = await inject({ method: 'GET', url: base(s), headers: H(s.token) });
    expect(after.statusCode).toBe(200);
    expect(after.json()).toEqual([]);
  });

  it('exposes correspondenceEnabled on the project response', async () => {
    const s = await setup();
    await enableModule(s.token, s.projectId);
    const proj = await inject({
      method: 'GET',
      url: `/api/teams/${s.teamId}/projects/${s.projectId}`,
      headers: H(s.token),
    });
    expect(proj.json().correspondenceEnabled).toBe(true);
  });

  it('non-admin cannot toggle the module (403)', async () => {
    const s = await setup();
    const member = await addMember(s.token, s.teamId, 'm@example.com', 'MANAGER');
    const res = await enableModule(member.token, s.projectId);
    expect(res.statusCode).toBe(403);
  });
});

describe('correspondence numbering + CRUD', () => {
  it('auto-numbers 1404-001 / 1404-002 and resets for a new Jalali year', async () => {
    const s = await setup();
    await enableModule(s.token, s.projectId);

    const l1 = await inject({
      method: 'POST',
      url: base(s),
      headers: H(s.token),
      payload: { direction: 'INCOMING', subject: 'First', letterDate: DATE_1404 },
    });
    expect(l1.statusCode).toBe(201);
    expect(l1.json().referenceNumber).toBe('1404-001');
    expect(l1.json().jalaliYear).toBe(1404);

    const l2 = await inject({
      method: 'POST',
      url: base(s),
      headers: H(s.token),
      payload: { direction: 'OUTGOING', subject: 'Second', letterDate: DATE_1404 },
    });
    expect(l2.json().referenceNumber).toBe('1404-002');

    const l3 = await inject({
      method: 'POST',
      url: base(s),
      headers: H(s.token),
      payload: { direction: 'INTERNAL', subject: 'New year', letterDate: DATE_1405 },
    });
    expect(l3.json().referenceNumber).toBe('1405-001');
    expect(l3.json().jalaliYear).toBe(1405);
  });

  it('assigns distinct reference numbers under concurrency', async () => {
    const s = await setup();
    await enableModule(s.token, s.projectId);

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        inject({
          method: 'POST',
          url: base(s),
          headers: H(s.token),
          payload: { direction: 'INCOMING', subject: `C${i}`, letterDate: DATE_1404 },
        }),
      ),
    );
    const refs = results.map((r) => r.json().referenceNumber);
    expect(new Set(refs).size).toBe(5);
    expect([...refs].sort()).toEqual([
      '1404-001',
      '1404-002',
      '1404-003',
      '1404-004',
      '1404-005',
    ]);
  });

  it('list filters by direction, status, and search', async () => {
    const s = await setup();
    await enableModule(s.token, s.projectId);

    await inject({
      method: 'POST',
      url: base(s),
      headers: H(s.token),
      payload: { direction: 'INCOMING', subject: 'Alpha incoming', letterDate: DATE_1404, status: 'DRAFT' },
    });
    await inject({
      method: 'POST',
      url: base(s),
      headers: H(s.token),
      payload: { direction: 'OUTGOING', subject: 'Beta outgoing', letterDate: DATE_1404, status: 'SENT' },
    });

    const incoming = await inject({
      method: 'GET',
      url: `${base(s)}?direction=INCOMING`,
      headers: H(s.token),
    });
    expect(incoming.json()).toHaveLength(1);
    expect(incoming.json()[0].subject).toBe('Alpha incoming');

    const sent = await inject({
      method: 'GET',
      url: `${base(s)}?status=SENT`,
      headers: H(s.token),
    });
    expect(sent.json()).toHaveLength(1);
    expect(sent.json()[0].subject).toBe('Beta outgoing');

    const search = await inject({
      method: 'GET',
      url: `${base(s)}?search=beta`,
      headers: H(s.token),
    });
    expect(search.json()).toHaveLength(1);
    expect(search.json()[0].subject).toBe('Beta outgoing');
  });

  it('keeps the reference number permanent when letterDate moves to another year', async () => {
    const s = await setup();
    await enableModule(s.token, s.projectId);
    const l = (
      await inject({
        method: 'POST',
        url: base(s),
        headers: H(s.token),
        payload: { direction: 'INCOMING', subject: 'Stay', letterDate: DATE_1404 },
      })
    ).json();
    expect(l.referenceNumber).toBe('1404-001');

    const upd = await inject({
      method: 'PATCH',
      url: `${base(s)}/${l.id}`,
      headers: H(s.token),
      payload: { letterDate: DATE_1405 },
    });
    expect(upd.statusCode).toBe(200);
    // Number unchanged; jalaliYear unchanged.
    expect(upd.json().referenceNumber).toBe('1404-001');
    expect(upd.json().jalaliYear).toBe(1404);
  });

  it('validates sender/recipient contacts belong to the team', async () => {
    const s = await setup();
    await enableModule(s.token, s.projectId);
    const contact = (
      await inject({
        method: 'POST',
        url: `/api/teams/${s.teamId}/contacts`,
        headers: H(s.token),
        payload: { name: 'Sender Co', type: 'ORG' },
      })
    ).json();

    const ok = await inject({
      method: 'POST',
      url: base(s),
      headers: H(s.token),
      payload: { direction: 'OUTGOING', subject: 'With sender', letterDate: DATE_1404, senderId: contact.id },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().sender.id).toBe(contact.id);

    const bad = await inject({
      method: 'POST',
      url: base(s),
      headers: H(s.token),
      payload: { direction: 'OUTGOING', subject: 'Bad sender', letterDate: DATE_1404, senderId: 'nope' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('sets status and soft-deletes', async () => {
    const s = await setup();
    await enableModule(s.token, s.projectId);
    const l = (
      await inject({
        method: 'POST',
        url: base(s),
        headers: H(s.token),
        payload: { direction: 'INCOMING', subject: 'S', letterDate: DATE_1404 },
      })
    ).json();

    const st = await inject({
      method: 'PATCH',
      url: `${base(s)}/${l.id}/status`,
      headers: H(s.token),
      payload: { status: 'ARCHIVED' },
    });
    expect(st.json().status).toBe('ARCHIVED');

    const del = await inject({ method: 'DELETE', url: `${base(s)}/${l.id}`, headers: H(s.token) });
    expect(del.statusCode).toBe(204);

    const get = await inject({ method: 'GET', url: `${base(s)}/${l.id}`, headers: H(s.token) });
    expect(get.statusCode).toBe(404);
  });
});

describe('correspondence cross-team isolation', () => {
  it('cross-team user gets 404 on another team enabled project', async () => {
    const a = await setup('a@example.com', 'team-a');
    await enableModule(a.token, a.projectId);
    const b = await setup('b@example.com', 'team-b');

    const res = await inject({ method: 'GET', url: base(a), headers: H(b.token) });
    expect(res.statusCode).toBe(404);
  });
});

describe('correspondence referral', () => {
  it('refers to a member, fires a notification, then the member marks it handled', async () => {
    const s = await setup();
    await enableModule(s.token, s.projectId);
    const member = await addMember(s.token, s.teamId, 'ref@example.com', 'MEMBER');

    const letter = (
      await inject({
        method: 'POST',
        url: base(s),
        headers: H(s.token),
        payload: { direction: 'INCOMING', subject: 'Please review', letterDate: DATE_1404 },
      })
    ).json();

    const refer = await inject({
      method: 'POST',
      url: `${base(s)}/${letter.id}/referrals`,
      headers: H(s.token),
      payload: { targets: [{ userId: member.userId, kind: 'ACTION', note: 'handle this' }] },
    });
    expect(refer.statusCode).toBe(201);
    const referral = refer.json().referrals.find((r: any) => r.userId === member.userId);
    expect(referral.status).toBe('PENDING');
    expect(referral.kind).toBe('ACTION');

    // The referred member got a CORRESPONDENCE_REFERRAL notification.
    const notes = await inject({ method: 'GET', url: '/api/notifications', headers: H(member.token) });
    const items = notes.json().items ?? notes.json();
    const found = (Array.isArray(items) ? items : []).find(
      (n: any) => n.type === 'CORRESPONDENCE_REFERRAL',
    );
    expect(found).toBeTruthy();

    // The member marks their own referral handled (no project write needed).
    const handle = await inject({
      method: 'POST',
      url: `${base(s)}/${letter.id}/referrals/${referral.id}/handle`,
      headers: H(member.token),
      payload: {},
    });
    expect(handle.statusCode).toBe(200);
    expect(handle.json().status).toBe('HANDLED');
    expect(handle.json().handledAt).toBeTruthy();
  });

  it('a different user cannot mark someone else referral handled (403)', async () => {
    const s = await setup();
    await enableModule(s.token, s.projectId);
    const target = await addMember(s.token, s.teamId, 't@example.com', 'MEMBER');
    const other = await addMember(s.token, s.teamId, 'o@example.com', 'MEMBER');

    const letter = (
      await inject({
        method: 'POST',
        url: base(s),
        headers: H(s.token),
        payload: { direction: 'INCOMING', subject: 'X', letterDate: DATE_1404 },
      })
    ).json();
    const refer = await inject({
      method: 'POST',
      url: `${base(s)}/${letter.id}/referrals`,
      headers: H(s.token),
      payload: { targets: [{ userId: target.userId, kind: 'INFO' }] },
    });
    const referralId = refer.json().referrals[0].id;

    const res = await inject({
      method: 'POST',
      url: `${base(s)}/${letter.id}/referrals/${referralId}/handle`,
      headers: H(other.token),
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it('re-referring resets a handled referral to PENDING', async () => {
    const s = await setup();
    await enableModule(s.token, s.projectId);
    const member = await addMember(s.token, s.teamId, 're@example.com', 'MEMBER');
    const letter = (
      await inject({
        method: 'POST',
        url: base(s),
        headers: H(s.token),
        payload: { direction: 'INCOMING', subject: 'R', letterDate: DATE_1404 },
      })
    ).json();
    const first = await inject({
      method: 'POST',
      url: `${base(s)}/${letter.id}/referrals`,
      headers: H(s.token),
      payload: { targets: [{ userId: member.userId, kind: 'ACTION' }] },
    });
    const refId = first.json().referrals[0].id;
    await inject({
      method: 'POST',
      url: `${base(s)}/${letter.id}/referrals/${refId}/handle`,
      headers: H(member.token),
      payload: {},
    });
    // Re-refer the same user — should reset to PENDING and keep one row.
    const again = await inject({
      method: 'POST',
      url: `${base(s)}/${letter.id}/referrals`,
      headers: H(s.token),
      payload: { targets: [{ userId: member.userId, kind: 'INFO' }] },
    });
    expect(again.json().referrals).toHaveLength(1);
    expect(again.json().referrals[0].status).toBe('PENDING');
    expect(again.json().referrals[0].kind).toBe('INFO');
  });
});

describe('correspondence attachments (polymorphic)', () => {
  it('uploads, lists, and downloads a letter attachment', async () => {
    const s = await setup();
    await enableModule(s.token, s.projectId);
    const letter = (
      await inject({
        method: 'POST',
        url: base(s),
        headers: H(s.token),
        payload: { direction: 'INCOMING', subject: 'WithFile', letterDate: DATE_1404 },
      })
    ).json();

    const boundary = '----testboundary1234';
    const fileContent = 'hello letter';
    const body =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="scan.txt"\r\n` +
      `Content-Type: text/plain\r\n\r\n` +
      `${fileContent}\r\n` +
      `--${boundary}--\r\n`;

    const up = await inject({
      method: 'POST',
      url: `${base(s)}/${letter.id}/attachments`,
      headers: { ...H(s.token), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(up.statusCode).toBe(201);
    // Polymorphism: correspondenceId set, taskId null.
    expect(up.json().correspondenceId).toBe(letter.id);
    expect(up.json().taskId).toBeNull();

    const list = await inject({
      method: 'GET',
      url: `${base(s)}/${letter.id}/attachments`,
      headers: H(s.token),
    });
    expect(list.json()).toHaveLength(1);

    const dl = await inject({
      method: 'GET',
      url: `${base(s)}/${letter.id}/attachments/${up.json().id}`,
      headers: H(s.token),
    });
    expect(dl.statusCode).toBe(200);
    expect(dl.body).toContain(fileContent);
  });
});

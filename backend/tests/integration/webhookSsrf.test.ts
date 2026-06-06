import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { _internal as ssrfInternal } from '../../src/lib/ssrfGuard.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';

// v1.30.7 (S-11): SSRF regression suite.
//
// The existing webhook tests POST to a stub HTTP server on 127.0.0.1 —
// tests/setup.ts allow-lists that host so they keep working. The cases
// below deliberately probe addresses that are NOT on the allow-list so
// the guard's refusal IS exercised. We use:
//   - Literal RFC 1918 / loopback / link-local IPs in the URL (no DNS
//     hit needed; the guard sees the IP directly).
//   - 169.254.169.254 specifically — the cloud-metadata address; if any
//     SSRF check misses one address, miss this one and Bad Things follow.
// We DON'T need to mock DNS rebinding; the second-resolve check is
// covered by a per-request guard call (any URL that resolves internal
// on either pass is refused).

let app: FastifyInstance;

beforeAll(async () => {
  process.env.MASTER_KEY ??=
    '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
  app = await buildApp(loadEnv());
});

afterAll(async () => {
  if (app) await app.close();
});

beforeEach(async () => {
  await prisma.webhookDelivery.deleteMany();
  await prisma.webhook.deleteMany();
  await prisma.rolePermission.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.role.deleteMany();
  await prisma.team.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.user.deleteMany();
});

const PASSWORD = 'CorrectHorseBattery9';

async function adminTeam(): Promise<{ token: string; teamId: string }> {
  const reg = await bootstrapUser(app, { email: 'admin@example.com', name: 'Admin', password: PASSWORD });
  const token = reg.token;
  const team = await app.inject({
    method: 'POST',
    url: '/api/teams',
    headers: { authorization: `Bearer ${token}` },
    payload: { name: 'ssrf-team', slug: 'ssrf-team' },
  });
  if (team.statusCode !== 201) throw new Error(`team: ${team.statusCode} ${team.body}`);
  return { token, teamId: team.json().id as string };
}

async function createWebhook(token: string, teamId: string, url: string): Promise<ReturnType<FastifyInstance['inject']>> {
  return app.inject({
    method: 'POST',
    url: `/api/teams/${teamId}/webhooks`,
    headers: { authorization: `Bearer ${token}` },
    payload: { name: 'h', url, events: ['*'] },
  });
}

describe('S-11 SSRF guard — unit-level address classifier', () => {
  // These checks don't go through DNS; they exercise the IP-range
  // classifier directly. Catch regressions where someone deletes a
  // range from BLOCKED_RANGES.
  it('blocks loopback (127.0.0.1)', () => {
    expect(ssrfInternal.isAddressInternal('127.0.0.1')).toBe(true);
  });
  it('blocks private (10.0.0.1, 192.168.1.1, 172.16.0.1)', () => {
    expect(ssrfInternal.isAddressInternal('10.0.0.1')).toBe(true);
    expect(ssrfInternal.isAddressInternal('192.168.1.1')).toBe(true);
    expect(ssrfInternal.isAddressInternal('172.16.0.1')).toBe(true);
  });
  it('blocks link-local INCLUDING cloud metadata (169.254.169.254)', () => {
    expect(ssrfInternal.isAddressInternal('169.254.169.254')).toBe(true);
  });
  it('blocks IPv6 loopback (::1) and unique-local (fc00::1)', () => {
    expect(ssrfInternal.isAddressInternal('::1')).toBe(true);
    expect(ssrfInternal.isAddressInternal('fc00::1')).toBe(true);
  });
  it('blocks IPv4-mapped IPv6 form of a private address (::ffff:10.0.0.1)', () => {
    // The classic SSRF bypass — recover the underlying IPv4 and
    // re-classify.
    expect(ssrfInternal.isAddressInternal('::ffff:10.0.0.1')).toBe(true);
  });
  it('lets a real public IP through (1.1.1.1)', () => {
    expect(ssrfInternal.isAddressInternal('1.1.1.1')).toBe(false);
  });
  it('lets a real public IPv6 through (2606:4700:4700::1111)', () => {
    expect(ssrfInternal.isAddressInternal('2606:4700:4700::1111')).toBe(false);
  });
});

describe('S-11 SSRF guard — webhook create rejects private targets', () => {
  it('rejects a webhook URL pointed at 192.168.1.50', async () => {
    const { token, teamId } = await adminTeam();
    const res = await createWebhook(token, teamId, 'http://192.168.1.50/webhook');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message.toLowerCase()).toContain('private');
  });

  it('rejects 169.254.169.254 specifically (cloud metadata)', async () => {
    const { token, teamId } = await adminTeam();
    const res = await createWebhook(
      token,
      teamId,
      'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/169\.254\.169\.254/);
  });

  it('rejects loopback (127.0.0.2 — NOT on the test allow-list)', async () => {
    // The test setup allow-lists 127.0.0.1 specifically, NOT a CIDR or
    // a wildcard. 127.0.0.2 is a different host string; it still
    // resolves loopback and must be refused.
    const { token, teamId } = await adminTeam();
    const res = await createWebhook(token, teamId, 'http://127.0.0.2:9999/hook');
    expect(res.statusCode).toBe(400);
  });

  it('rejects IPv6 loopback ([::1])', async () => {
    const { token, teamId } = await adminTeam();
    const res = await createWebhook(token, teamId, 'http://[::1]/hook');
    expect(res.statusCode).toBe(400);
  });

  it('rejects IPv4-mapped IPv6 ([::ffff:10.0.0.1])', async () => {
    const { token, teamId } = await adminTeam();
    const res = await createWebhook(token, teamId, 'http://[::ffff:10.0.0.1]/hook');
    expect(res.statusCode).toBe(400);
  });

  it('rejects non-http/https schemes (file://, gopher://)', async () => {
    const { token, teamId } = await adminTeam();
    const r1 = await createWebhook(token, teamId, 'file:///etc/passwd');
    expect(r1.statusCode).toBe(400);
    const r2 = await createWebhook(token, teamId, 'gopher://1.1.1.1/');
    expect(r2.statusCode).toBe(400);
  });

  it('allows the test allow-list entry (127.0.0.1) — sanity for tests/setup.ts', async () => {
    // The existing receiver-stub tests need this. If this assertion
    // ever fails, every other webhook test in the suite breaks too.
    const { token, teamId } = await adminTeam();
    const res = await createWebhook(token, teamId, 'http://127.0.0.1:9999/hook');
    expect(res.statusCode).toBe(201);
  });
});

describe('S-11 SSRF guard — delivery refuses internal targets', () => {
  it('a webhook whose URL is rewritten directly in the DB to point at a private IP still gets refused at delivery', async () => {
    // Create a webhook against an allow-listed host so create()
    // succeeds, then mutate the URL behind the service's back to
    // simulate a DNS-rebound target (or a tampered DB). Trigger a
    // delivery — the deliver-time guard must refuse.
    const { token, teamId } = await adminTeam();
    const createRes = await createWebhook(token, teamId, 'http://127.0.0.1:9999/hook');
    expect(createRes.statusCode).toBe(201);
    const webhookId = createRes.json().id as string;

    await prisma.webhook.update({
      where: { id: webhookId },
      data: { url: 'http://10.99.99.99/hook' },
    });

    // testSend is the synchronous delivery path. The guard runs in
    // deliverOnce → testSend returns ok:false with the guard reason.
    const test = await app.inject({
      method: 'POST',
      url: `/api/teams/${teamId}/webhooks/${webhookId}/test`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(test.statusCode).toBe(200);
    const body = test.json() as { ok: boolean; errorMessage?: string };
    expect(body.ok).toBe(false);
    expect(body.errorMessage).toMatch(/SSRF guard refused/i);
  });
});

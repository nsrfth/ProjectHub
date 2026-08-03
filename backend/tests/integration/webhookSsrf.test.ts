import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import {
  SsrfBlockedError,
  _internal as ssrfInternal,
  resolveSafeTarget,
  type ResolvedAddress,
} from '../../src/lib/ssrfGuard.js';
import {
  buildPinnedRequestOptions,
  sendPinnedRequest,
  type PinnedRequestInput,
} from '../../src/lib/pinnedHttp.js';
import { WebhookService } from '../../src/services/webhookService.js';
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
// v2.23.3 (S-11b) adds the DNS-REBINDING half of the suite. Up to
// v2.23.2 the guard resolved the host, approved it, and then handed the
// URL to fetch() — which resolved it AGAIN. The cases below drive a
// deterministic resolver that answers "public" once and "internal"
// afterwards (exactly what an attacker's authoritative server does) and
// assert that (a) the second answer never becomes a connection and (b)
// the address the transport is handed is the one that was validated.

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

// ── v2.23.3 (S-11b) DNS-rebinding regression suite ────────────────────

// Genuinely public unicast addresses. NOT the TEST-NET documentation
// ranges (203.0.113.0/24 etc.) — ipaddr.js classifies those as
// `reserved`, which the guard blocks, so they cannot stand in for "a
// public answer" here.
const PUBLIC_ADDR = '93.184.216.34';
const PUBLIC_ADDR_2 = '1.1.1.1';

// A resolver that answers with `answers[i]` on the i-th call and repeats
// the last answer thereafter — the shape of a rebinding attack.
function rebindingResolver(answers: ResolvedAddress[][]): {
  resolve: (host: string) => Promise<ResolvedAddress[]>;
  calls: () => number;
} {
  let n = 0;
  return {
    resolve: async () => {
      const answer = answers[Math.min(n, answers.length - 1)]!;
      n += 1;
      return answer;
    },
    calls: () => n,
  };
}

function v4(address: string): ResolvedAddress[] {
  return [{ address, family: 4 }];
}

async function makeWebhook(
  svc: WebhookService,
  teamId: string,
  url: string,
): Promise<string> {
  const { view } = await svc.create(teamId, { name: 'pinned', url, events: ['*'] });
  return view.id;
}

describe('S-11b SSRF guard — DNS rebinding cannot reach the second address', () => {
  // Each case: the guard sees a public address (so create() succeeds),
  // then the attacker's DNS flips to an internal one. Delivery must
  // refuse — and must never hand the transport the internal address.
  const REBIND_TARGETS: Array<[string, ResolvedAddress[]]> = [
    ['127.0.0.1 (loopback)', v4('127.0.0.1')],
    ['10.1.2.3 (RFC1918)', v4('10.1.2.3')],
    ['192.168.4.5 (RFC1918)', v4('192.168.4.5')],
    ['169.254.169.254 (cloud metadata)', v4('169.254.169.254')],
    ['::1 (IPv6 loopback)', [{ address: '::1', family: 6 }]],
    ['::ffff:127.0.0.1 (IPv4-mapped IPv6)', [{ address: '::ffff:127.0.0.1', family: 6 }]],
  ];

  for (const [label, second] of REBIND_TARGETS) {
    it(`refuses a host that rebinds to ${label}`, async () => {
      const { teamId } = await adminTeam();
      const dns = rebindingResolver([v4(PUBLIC_ADDR), second]);
      const sent: PinnedRequestInput[] = [];
      const svc = new WebhookService({
        resolve: dns.resolve,
        request: async (input) => {
          sent.push(input);
          return { status: 200, redirected: false };
        },
      });

      // Call 1 — public, so creation is allowed.
      const id = await makeWebhook(svc, teamId, 'http://rebind.test/hook');
      // Call 2 — the rebound answer. Delivery must refuse.
      const res = await svc.testSend(teamId, id);
      expect(res.ok).toBe(false);
      expect(res.errorMessage).toMatch(/SSRF guard refused/i);
      // The decisive assertion: nothing was ever sent, so the internal
      // address was never contacted.
      expect(sent).toHaveLength(0);
      expect(dns.calls()).toBe(2);
    });
  }

  it('refuses a dual-stack answer where only ONE record is internal', async () => {
    const { teamId } = await adminTeam();
    const dns = rebindingResolver([
      v4(PUBLIC_ADDR),
      [
        { address: PUBLIC_ADDR, family: 4 },
        { address: '10.0.0.7', family: 4 },
      ],
    ]);
    const sent: PinnedRequestInput[] = [];
    const svc = new WebhookService({
      resolve: dns.resolve,
      request: async (input) => {
        sent.push(input);
        return { status: 200, redirected: false };
      },
    });
    const id = await makeWebhook(svc, teamId, 'http://dualstack.test/hook');
    const res = await svc.testSend(teamId, id);
    expect(res.ok).toBe(false);
    expect(res.errorMessage).toMatch(/10\.0\.0\.7/);
    expect(sent).toHaveLength(0);
  });

  it('hands the transport the address that was validated — not the hostname', async () => {
    const { teamId } = await adminTeam();
    // Answer changes between calls, but BOTH answers are public: the
    // point here is which address the transport receives, and that it is
    // the one resolved for THIS delivery.
    const dns = rebindingResolver([v4(PUBLIC_ADDR), v4(PUBLIC_ADDR_2)]);
    const sent: PinnedRequestInput[] = [];
    const svc = new WebhookService({
      resolve: dns.resolve,
      request: async (input) => {
        sent.push(input);
        return { status: 200, redirected: false };
      },
    });
    const id = await makeWebhook(svc, teamId, 'https://pinned.test/hook');
    const res = await svc.testSend(teamId, id);
    expect(res.ok).toBe(true);
    expect(sent).toHaveLength(1);
    // The delivery's own resolution (call #2) is what got pinned.
    expect(sent[0]!.target.address).toBe(PUBLIC_ADDR_2);
    // …while the hostname is preserved for Host + SNI.
    expect(sent[0]!.target.hostname).toBe('pinned.test');
    expect(sent[0]!.target.port).toBe(443);
  });

  it('resolveSafeTarget pins an allow-listed internal host instead of leaving it to be re-resolved', async () => {
    const target = await resolveSafeTarget('http://internal-monitor.test:9000/hook', {
      allowedHosts: ['internal-monitor.test'],
      resolve: async () => v4('10.20.30.40'),
    });
    expect(target.allowListed).toBe(true);
    expect(target.address).toBe('10.20.30.40');
    expect(target.hostname).toBe('internal-monitor.test');
  });

  it('a non-allow-listed host resolving to an internal address is refused outright', async () => {
    await expect(
      resolveSafeTarget('http://evil.test/hook', {
        allowedHosts: [],
        resolve: async () => v4('169.254.169.254'),
      }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });
});

describe('S-11b pinned transport — options preserve Host, SNI and TLS validation', () => {
  it('builds https options with the original hostname as servername and TLS validation left on', async () => {
    const target = await resolveSafeTarget('https://hook.example.test/path?x=1', {
      allowedHosts: [],
      resolve: async () => v4(PUBLIC_ADDR),
    });
    const options = buildPinnedRequestOptions({
      target,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      timeoutMs: 1000,
    });
    expect(options.hostname).toBe('hook.example.test');
    expect(options.servername).toBe('hook.example.test');
    expect((options.headers as Record<string, string>).host).toBe('hook.example.test');
    expect(options.path).toBe('/path?x=1');
    // Never weakened: undefined means "node's default", which is true.
    expect(options.rejectUnauthorized).toBeUndefined();
    // No pooled agent — a reused socket could belong to a different pin.
    expect(options.agent).toBe(false);
    // And the lookup answers only with the validated address.
    const lookup = options.lookup as unknown as (
      h: string,
      o: { all?: boolean },
      cb: (e: null, a: unknown, f?: number) => void,
    ) => void;
    const seen: unknown[] = [];
    lookup('hook.example.test', {}, (_e, a, f) => seen.push([a, f]));
    lookup('hook.example.test', { all: true }, (_e, a) => seen.push(a));
    expect(seen[0]).toEqual([PUBLIC_ADDR, 4]);
    expect(seen[1]).toEqual([{ address: PUBLIC_ADDR, family: 4 }]);
  });

  it('connects to the pinned address for a hostname that does not resolve at all', async () => {
    // `.invalid` is guaranteed never to resolve (RFC 2606). If the
    // transport did its own DNS lookup this request could not connect —
    // it succeeds only because the pinned address is used.
    const received: { host?: string; url?: string } = {};
    const server = http.createServer((req, res) => {
      received.host = req.headers.host;
      received.url = req.url;
      res.writeHead(204).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const res = await sendPinnedRequest({
        target: {
          url: new URL(`http://never-resolves.invalid:${port}/hook`),
          hostname: 'never-resolves.invalid',
          port,
          address: '127.0.0.1',
          family: 4,
          allowListed: false,
        },
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        timeoutMs: 5000,
      });
      expect(res.status).toBe(204);
      // Host header carries the configured NAME, not the pinned IP.
      expect(received.host).toBe(`never-resolves.invalid:${port}`);
      expect(received.url).toBe('/hook');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('validates the TLS certificate against the original hostname (self-signed is refused)', async () => {
    const tls = await makeSelfSignedCert('some-other-host.invalid');
    if (!tls) {
      // openssl is not available in this environment; the assertion below
      // cannot be made without a certificate to serve.
      expect(tls).toBeNull();
      return;
    }
    const server = https.createServer({ key: tls.key, cert: tls.cert }, (_req, res) => {
      res.writeHead(200).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      await expect(
        sendPinnedRequest({
          target: {
            url: new URL(`https://pinned-cert.invalid:${port}/hook`),
            hostname: 'pinned-cert.invalid',
            port,
            address: '127.0.0.1',
            family: 4,
            allowListed: false,
          },
          method: 'POST',
          headers: {},
          body: '{}',
          timeoutMs: 5000,
        }),
        // Self-signed AND issued for a different name: either complaint
        // proves the chain + hostname check are still enforced.
      ).rejects.toThrow(/self.signed|self signed|certificate|altname/i);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

// openssl is present in the backend container (postgresql-client pulls it
// in) and on developer machines; return null when it isn't so the suite
// degrades to a skipped assertion rather than a false failure.
async function makeSelfSignedCert(
  commonName: string,
): Promise<{ key: string; cert: string } | null> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'taskhub-tls-test-'));
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  const out = spawnSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', certPath, '-days', '1',
      '-subj', `/CN=${commonName}`,
    ],
    { stdio: 'ignore' },
  );
  if (out.error || out.status !== 0) {
    await fs.rm(dir, { recursive: true, force: true });
    return null;
  }
  const [key, cert] = await Promise.all([
    fs.readFile(keyPath, 'utf8'),
    fs.readFile(certPath, 'utf8'),
  ]);
  await fs.rm(dir, { recursive: true, force: true });
  return { key, cert };
}

describe('S-11b delivery through the real transport', () => {
  it('delivers to an explicitly allow-listed internal host, signature + headers intact', async () => {
    const { teamId } = await adminTeam();
    const seen: { headers: http.IncomingHttpHeaders; body: string }[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ headers: req.headers, body });
        res.writeHead(200).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      // No injected transport: this exercises sendPinnedRequest for real.
      const svc = new WebhookService();
      const { view, rawSecret } = await svc.create(teamId, {
        name: 'local',
        url: `http://127.0.0.1:${port}/hook`,
        events: ['*'],
      });
      const res = await svc.testSend(teamId, view.id);
      expect(res.ok).toBe(true);
      expect(res.httpStatus).toBe(200);
      expect(seen).toHaveLength(1);
      const expected = crypto
        .createHmac('sha256', rawSecret)
        .update(seen[0]!.body)
        .digest('hex');
      expect(seen[0]!.headers['x-taskhub-signature']).toBe(`sha256=${expected}`);
      expect(seen[0]!.headers['x-taskhub-event']).toBe('webhook.test');
      expect(seen[0]!.headers['x-taskhub-delivery']).toMatch(/^test-/);
      expect(seen[0]!.headers.host).toBe(`127.0.0.1:${port}`);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('refuses a redirect to an internal address instead of following it', async () => {
    const { teamId } = await adminTeam();
    let hits = 0;
    const server = http.createServer((_req, res) => {
      hits += 1;
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const svc = new WebhookService();
      const { view } = await svc.create(teamId, {
        name: 'redirector',
        url: `http://127.0.0.1:${port}/hook`,
        events: ['*'],
      });
      const res = await svc.testSend(teamId, view.id);
      expect(res.ok).toBe(false);
      expect(res.errorMessage).toMatch(/redirect/i);
      // Exactly one request: the Location was never followed.
      expect(hits).toBe(1);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
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

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import http from 'node:http';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { WebhookService } from '../../src/services/webhookService.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';

// Phase 3B coverage: API token auth round-trip, webhook delivery + HMAC
// signature, retry/backoff after a 5xx, test-send endpoint.
// Uses a local http.createServer as the webhook receiver so the test runs
// without any external network dependency.

let app: FastifyInstance;
let receiver: http.Server;
let receiverPort: number;
let receivedRequests: Array<{
  url: string | undefined;
  method: string | undefined;
  headers: http.IncomingHttpHeaders;
  body: string;
}> = [];

// Receiver behaviour overrides per test — keys are paths.
let receiverBehavior: Record<string, { status: number; bodyOnce?: boolean; failuresBeforeOk?: number }> = {};
const receiverFailureCounts = new Map<string, number>();

beforeAll(async () => {
  process.env.MASTER_KEY ??= '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
  app = await buildApp(loadEnv());

  // Stand up a stub HTTP receiver. Each test wires receiverBehavior to
  // control the response per path.
  receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const path = req.url ?? '/';
      const behavior = receiverBehavior[path] ?? { status: 200 };
      // Optional: fail the first N attempts, then succeed.
      if (behavior.failuresBeforeOk) {
        const seen = receiverFailureCounts.get(path) ?? 0;
        if (seen < behavior.failuresBeforeOk) {
          receiverFailureCounts.set(path, seen + 1);
          receivedRequests.push({ url: req.url, method: req.method, headers: req.headers, body });
          res.writeHead(500); res.end('try again');
          return;
        }
      }
      receivedRequests.push({ url: req.url, method: req.method, headers: req.headers, body });
      res.writeHead(behavior.status);
      res.end('ok');
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', () => resolve()));
  const addr = receiver.address();
  receiverPort = typeof addr === 'object' && addr ? addr.port : 0;
});

afterAll(async () => {
  if (app) await app.close();
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
});

beforeEach(async () => {
  await prisma.webhookDelivery.deleteMany();
  await prisma.webhook.deleteMany();
  await prisma.apiToken.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.task.deleteMany();
  await prisma.project.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
  receivedRequests = [];
  receiverBehavior = {};
  receiverFailureCounts.clear();
});

async function register(email: string): Promise<{ token: string; userId: string }> {
  const r = await bootstrapUser(app, { email, name: email.split('@')[0], password: 'CorrectHorseBattery9' });
  return { token: r.token, userId: r.userId };
}

async function createTeam(token: string, slug: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/teams',
    headers: { authorization: `Bearer ${token}` },
    payload: { name: slug, slug },
  });
  return res.json().id;
}

describe('API tokens', () => {
  it('generates a token, lists it (without raw), and authenticates a normal route call', async () => {
    const { token } = await register('admin@example.com');

    const gen = await app.inject({
      method: 'POST',
      url: '/api/settings/api-tokens',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'ci', scopes: ['*'] },
    });
    expect(gen.statusCode).toBe(201);
    const created = gen.json();
    expect(created.rawToken).toMatch(/^th_[a-f0-9]{48}$/);
    expect(created.prefix).toBe(created.rawToken.slice(0, 11));

    // Listing never returns rawToken.
    const list = await app.inject({
      method: 'GET',
      url: '/api/settings/api-tokens',
      headers: { authorization: `Bearer ${token}` },
    });
    const items = list.json().items as Array<{ rawToken?: string }>;
    expect(items).toHaveLength(1);
    expect(items[0]!.rawToken).toBeUndefined();

    // Use the raw token to hit a normal authenticated route.
    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${created.rawToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().email).toBe('admin@example.com');
  });

  it('revoked tokens no longer authenticate', async () => {
    const { token } = await register('admin@example.com');
    const gen = await app.inject({
      method: 'POST',
      url: '/api/settings/api-tokens',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'ci', scopes: ['*'] },
    });
    const raw: string = gen.json().rawToken;
    const id: string = gen.json().id;

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/settings/api-tokens/${id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del.statusCode).toBe(204);

    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${raw}` },
    });
    expect(me.statusCode).toBe(401);
  });

  // ── v1.30.3 (S-2): scope enforcement on API tokens ────────────────────
  //
  // Until this release, an API token's `scopes` array was stored and
  // attached to the request but never validated. A `tasks:read` token
  // could DELETE any task — or mint another API token. requireScope is
  // now installed on every write route + most reads. The tests below
  // pin the contract:
  //   1. A `tasks:read` token gets 403 on task POST + 403 on task DELETE.
  //   2. The same token gets 200 on task GET.
  //   3. A `*`-scoped token behaves like a session (full access).
  //   4. A normal JWT session is unaffected (no apiTokenScopes on the
  //      request → implicit `*`).
  //   5. API tokens — even `*` ones — cannot mint OTHER API tokens
  //      (requireSessionAuth on /api/settings/api-tokens).
  describe('S-2 scope enforcement', () => {
    async function setup(scopes: string[]): Promise<{
      jwtToken: string;
      apiRaw: string;
      teamId: string;
      projectId: string;
      taskId: string;
    }> {
      const { token: jwtToken } = await register('admin@example.com');
      const teamId = await createTeam(jwtToken, 's2-team');
      const proj = await app.inject({
        method: 'POST',
        url: `/api/teams/${teamId}/projects`,
        headers: { authorization: `Bearer ${jwtToken}` },
        payload: { name: 'P' },
      });
      const projectId = proj.json().id as string;
      const task = await app.inject({
        method: 'POST',
        url: `/api/teams/${teamId}/projects/${projectId}/tasks`,
        headers: { authorization: `Bearer ${jwtToken}` },
        payload: { title: 'seed' },
      });
      const taskId = task.json().id as string;

      const gen = await app.inject({
        method: 'POST',
        url: '/api/settings/api-tokens',
        headers: { authorization: `Bearer ${jwtToken}` },
        payload: { name: 's2', scopes },
      });
      if (gen.statusCode !== 201) {
        throw new Error(`token mint failed: ${gen.statusCode} ${gen.body}`);
      }
      return { jwtToken, apiRaw: gen.json().rawToken as string, teamId, projectId, taskId };
    }

    it('rejects POST /tasks with a tasks:read token (403)', async () => {
      const { apiRaw, teamId, projectId } = await setup(['tasks:read']);
      const res = await app.inject({
        method: 'POST',
        url: `/api/teams/${teamId}/projects/${projectId}/tasks`,
        headers: { authorization: `Bearer ${apiRaw}` },
        payload: { title: 'should-not-create' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.message).toContain('tasks:write');
    });

    it('rejects DELETE /tasks/:id with a tasks:read token (403)', async () => {
      const { apiRaw, teamId, projectId, taskId } = await setup(['tasks:read']);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/teams/${teamId}/projects/${projectId}/tasks/${taskId}`,
        headers: { authorization: `Bearer ${apiRaw}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('allows GET /tasks/:id with the same tasks:read token (200)', async () => {
      const { apiRaw, teamId, projectId, taskId } = await setup(['tasks:read']);
      const res = await app.inject({
        method: 'GET',
        url: `/api/teams/${teamId}/projects/${projectId}/tasks/${taskId}`,
        headers: { authorization: `Bearer ${apiRaw}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().id).toBe(taskId);
    });

    it('a `*`-scoped token can write (POST returns 201, DELETE returns 204)', async () => {
      const { apiRaw, teamId, projectId } = await setup(['*']);
      const create = await app.inject({
        method: 'POST',
        url: `/api/teams/${teamId}/projects/${projectId}/tasks`,
        headers: { authorization: `Bearer ${apiRaw}` },
        payload: { title: 'wildcard-can-write' },
      });
      expect(create.statusCode).toBe(201);
      const newId = create.json().id as string;
      const del = await app.inject({
        method: 'DELETE',
        url: `/api/teams/${teamId}/projects/${projectId}/tasks/${newId}`,
        headers: { authorization: `Bearer ${apiRaw}` },
      });
      expect(del.statusCode).toBe(204);
    });

    it('a normal JWT session is unaffected — POST returns 201', async () => {
      // No API token at all; the requireScope middleware sees no
      // apiTokenScopes on the request and lets it through.
      const { jwtToken, teamId, projectId } = await setup(['tasks:read']);
      const res = await app.inject({
        method: 'POST',
        url: `/api/teams/${teamId}/projects/${projectId}/tasks`,
        headers: { authorization: `Bearer ${jwtToken}` },
        payload: { title: 'session-can-write' },
      });
      expect(res.statusCode).toBe(201);
    });

    it('a comments:write-only token cannot DELETE a task (403)', async () => {
      const { apiRaw, teamId, projectId, taskId } = await setup(['comments:write']);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/teams/${teamId}/projects/${projectId}/tasks/${taskId}`,
        headers: { authorization: `Bearer ${apiRaw}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('rejects scope strings outside the vocabulary at create time (400)', async () => {
      const { token } = await register('admin@example.com');
      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/api-tokens',
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'bad', scopes: ['typo:write'] },
      });
      expect(res.statusCode).toBe(400);
    });

    it('a `*`-scoped API token cannot mint another API token (defense-in-depth, 403)', async () => {
      const { apiRaw } = await setup(['*']);
      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/api-tokens',
        headers: { authorization: `Bearer ${apiRaw}` },
        payload: { name: 'should-not-mint', scopes: ['*'] },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.message).toContain('not callable with an API token');
    });

    it('a `*`-scoped API token cannot disable 2FA on the owning user (403)', async () => {
      const { apiRaw } = await setup(['*']);
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/2fa/disable',
        headers: { authorization: `Bearer ${apiRaw}` },
        payload: { code: '000000' },
      });
      expect(res.statusCode).toBe(403);
    });
  });
});

describe('Webhooks', () => {
  async function setupWebhook(opts: { events: string[]; path?: string }) {
    const { token, userId } = await register('admin@example.com');
    const teamId = await createTeam(token, 'team-a');
    const path = opts.path ?? '/hook';
    const url = `http://127.0.0.1:${receiverPort}${path}`;
    const create = await app.inject({
      method: 'POST',
      url: `/api/teams/${teamId}/webhooks`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'test', url, events: opts.events },
    });
    expect(create.statusCode).toBe(201);
    return {
      token,
      userId,
      teamId,
      webhookId: create.json().id as string,
      rawSecret: create.json().rawSecret as string,
      path,
    };
  }

  it('delivers task.created with a valid HMAC signature', async () => {
    const { token, teamId, rawSecret, path } = await setupWebhook({ events: ['task.created'] });

    // Trigger task.created via the real API.
    const proj = await app.inject({
      method: 'POST', url: `/api/teams/${teamId}/projects`,
      headers: { authorization: `Bearer ${token}` }, payload: { name: 'P' },
    });
    const projectId: string = proj.json().id;
    await app.inject({
      method: 'POST',
      url: `/api/teams/${teamId}/projects/${projectId}/tasks`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'first' },
    });

    // Drain the queue (the dispatcher loop isn't running in tests).
    const svc = new WebhookService();
    await svc.drainOnce();

    // One inbound POST to our path, HMAC verifies.
    const got = receivedRequests.find((r) => r.url === path);
    expect(got).toBeTruthy();
    expect(got!.method).toBe('POST');
    expect(got!.headers['x-taskhub-event']).toBe('task.created');
    const expectedSig = 'sha256=' + crypto.createHmac('sha256', rawSecret).update(got!.body).digest('hex');
    expect(got!.headers['x-taskhub-signature']).toBe(expectedSig);

    // Delivery row reflects success.
    const delivery = (await prisma.webhookDelivery.findMany())[0]!;
    expect(delivery.status).toBe('DELIVERED');
    expect(delivery.httpStatus).toBe(200);
    expect(delivery.attempt).toBe(1);
  });

  it('retries with exponential backoff on 5xx', async () => {
    const { token, teamId, path } = await setupWebhook({ events: ['task.created'], path: '/retry' });
    receiverBehavior[path] = { status: 200, failuresBeforeOk: 1 };

    const proj = await app.inject({
      method: 'POST', url: `/api/teams/${teamId}/projects`,
      headers: { authorization: `Bearer ${token}` }, payload: { name: 'P' },
    });
    await app.inject({
      method: 'POST',
      url: `/api/teams/${teamId}/projects/${proj.json().id}/tasks`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'will-retry' },
    });

    const svc = new WebhookService();
    // First attempt fails — row goes back to PENDING with nextAttemptAt in the future.
    await svc.drainOnce();
    let row = (await prisma.webhookDelivery.findMany())[0]!;
    expect(row.status).toBe('PENDING');
    expect(row.attempt).toBe(1);
    expect(row.httpStatus).toBe(500);
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    // Pull nextAttemptAt back so the next drain picks it up.
    await prisma.webhookDelivery.update({
      where: { id: row.id },
      data: { nextAttemptAt: new Date() },
    });
    await svc.drainOnce();
    row = (await prisma.webhookDelivery.findMany())[0]!;
    expect(row.status).toBe('DELIVERED');
    expect(row.attempt).toBe(2);
    expect(row.httpStatus).toBe(200);
  });

  it('test-send fires synchronously and returns the outcome', async () => {
    const { token, teamId, webhookId, path } = await setupWebhook({ events: ['*'], path: '/sync' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/teams/${teamId}/webhooks/${webhookId}/test`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.json().httpStatus).toBe(200);
    // The receiver saw the webhook.test event.
    const got = receivedRequests.find((r) => r.url === path);
    expect(got).toBeTruthy();
    expect(got!.headers['x-taskhub-event']).toBe('webhook.test');
  });

  it('paused webhook (active=false) receives no delivery', async () => {
    const { token, teamId, webhookId } = await setupWebhook({ events: ['task.created'], path: '/paused' });
    // Pause.
    await app.inject({
      method: 'PATCH',
      url: `/api/teams/${teamId}/webhooks/${webhookId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { active: false },
    });
    // Trigger.
    const proj = await app.inject({
      method: 'POST', url: `/api/teams/${teamId}/projects`,
      headers: { authorization: `Bearer ${token}` }, payload: { name: 'P' },
    });
    await app.inject({
      method: 'POST',
      url: `/api/teams/${teamId}/projects/${proj.json().id}/tasks`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'silent' },
    });
    const svc = new WebhookService();
    await svc.drainOnce();
    const deliveries = await prisma.webhookDelivery.count();
    expect(deliveries).toBe(0);
  });
});

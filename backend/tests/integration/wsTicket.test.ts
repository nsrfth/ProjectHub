import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';

// W1.3: the notifications WS auth is now a one-time ticket minted over an
// authenticated POST (was ?token=<accessToken> in the URL). This covers the
// mint endpoint; the store's single-use/expiry guarantees are in the unit test.

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
  await prisma.user.deleteMany();
});

const PASSWORD = 'CorrectHorseBattery9';

describe('POST /api/ws/ticket (W1.3)', () => {
  it('requires authentication', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/ws/ticket' });
    expect(res.statusCode).toBe(401);
  });

  it('mints a ticket for an authenticated user', async () => {
    const u = await bootstrapUser(app, { email: 'a@example.com', password: PASSWORD });
    const res = await app.inject({
      method: 'POST',
      url: '/api/ws/ticket',
      headers: { authorization: `Bearer ${u.token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ticket: string; expiresInSec: number };
    expect(typeof body.ticket).toBe('string');
    expect(body.ticket.length).toBeGreaterThan(20);
    expect(body.expiresInSec).toBe(30);
  });

  it('mints a distinct ticket on each call (tickets are single-use)', async () => {
    const u = await bootstrapUser(app, { email: 'a@example.com', password: PASSWORD });
    const headers = { authorization: `Bearer ${u.token}` };
    const t1 = (await app.inject({ method: 'POST', url: '/api/ws/ticket', headers })).json().ticket;
    const t2 = (await app.inject({ method: 'POST', url: '/api/ws/ticket', headers })).json().ticket;
    expect(t1).not.toBe(t2);
  });
});

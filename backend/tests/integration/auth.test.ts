import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';

// Integration tests hit a real Postgres (per the user's preference for real
// dependencies in tests). Run via: DATABASE_URL=... npm test
// CI should provision an ephemeral Postgres, run `prisma migrate deploy`, then `npm test`.

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
  // Tables in dependency order; cascade handles the rest but explicit is safer.
  await prisma.refreshToken.deleteMany();
  await prisma.passwordReset.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.user.deleteMany();
});

async function inject(opts: Parameters<FastifyInstance['inject']>[0]) {
  return app.inject(opts);
}

const VALID_PASSWORD = 'CorrectHorseBattery9';

describe('POST /api/auth/register', () => {
  it('creates a user and returns access token + refresh cookie', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'a@example.com', name: 'Alice', password: VALID_PASSWORD },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.accessToken).toBeTypeOf('string');
    expect(body.user.email).toBe('a@example.com');
    expect(body.user.globalRole).toBe('ADMIN'); // first user
    expect(res.cookies.find((c) => c.name === 'th_refresh')).toBeTruthy();
  });

  it('second user is MEMBER, not ADMIN', async () => {
    await inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'a@example.com', name: 'Alice', password: VALID_PASSWORD },
    });
    const res = await inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'b@example.com', name: 'Bob', password: VALID_PASSWORD },
    });
    expect(res.json().user.globalRole).toBe('MEMBER');
  });

  it('rejects duplicate email', async () => {
    await inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'a@example.com', name: 'Alice', password: VALID_PASSWORD },
    });
    const res = await inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'a@example.com', name: 'Alice2', password: VALID_PASSWORD },
    });
    expect(res.statusCode).toBe(409);
  });

  it('rejects weak password', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'a@example.com', name: 'Alice', password: 'short' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /api/auth/login', () => {
  beforeEach(async () => {
    await inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'a@example.com', name: 'Alice', password: VALID_PASSWORD },
    });
  });

  it('returns access token on correct credentials', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'a@example.com', password: VALID_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().accessToken).toBeTypeOf('string');
  });

  it('rejects wrong password with same error as unknown user', async () => {
    const wrongPw = await inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'a@example.com', password: 'WrongPassword99X' },
    });
    const unknown = await inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'nobody@example.com', password: 'WrongPassword99X' },
    });
    expect(wrongPw.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrongPw.json().error.code).toBe(unknown.json().error.code);
  });
});

describe('POST /api/auth/refresh', () => {
  it('rotates the refresh token and revokes the old one', async () => {
    const reg = await inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'a@example.com', name: 'Alice', password: VALID_PASSWORD },
    });
    const cookie = reg.cookies.find((c) => c.name === 'th_refresh')!;

    const first = await inject({
      method: 'POST',
      url: '/api/auth/refresh',
      cookies: { th_refresh: cookie.value },
    });
    expect(first.statusCode).toBe(200);

    // Reusing the original refresh cookie should now fail (token revoked).
    const replay = await inject({
      method: 'POST',
      url: '/api/auth/refresh',
      cookies: { th_refresh: cookie.value },
    });
    expect(replay.statusCode).toBe(401);
  });
});

describe('GET /api/auth/me', () => {
  it('requires a bearer token', async () => {
    const res = await inject({ method: 'GET', url: '/api/auth/me' });
    expect(res.statusCode).toBe(401);
  });

  it('returns the user when authorized', async () => {
    const reg = await inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'a@example.com', name: 'Alice', password: VALID_PASSWORD },
    });
    const { accessToken } = reg.json();
    const res = await inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().email).toBe('a@example.com');
  });
});

describe('password reset', () => {
  it('issues a token, accepts it, revokes existing sessions', async () => {
    const reg = await inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'a@example.com', name: 'Alice', password: VALID_PASSWORD },
    });
    const cookie = reg.cookies.find((c) => c.name === 'th_refresh')!;

    const reqReset = await inject({
      method: 'POST',
      url: '/api/auth/password/reset-request',
      payload: { email: 'a@example.com' },
    });
    expect(reqReset.statusCode).toBe(202);
    const token = reqReset.json().devResetToken as string;
    expect(token).toBeTypeOf('string');

    const newPw = 'BrandNewPass1234';
    const perform = await inject({
      method: 'POST',
      url: '/api/auth/password/reset',
      payload: { token, password: newPw },
    });
    expect(perform.statusCode).toBe(204);

    // Old refresh token is now revoked.
    const replay = await inject({
      method: 'POST',
      url: '/api/auth/refresh',
      cookies: { th_refresh: cookie.value },
    });
    expect(replay.statusCode).toBe(401);

    // New password works.
    const loginNew = await inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'a@example.com', password: newPw },
    });
    expect(loginNew.statusCode).toBe(200);
  });

  it('does not enumerate accounts on reset-request for unknown email', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/auth/password/reset-request',
      payload: { email: 'ghost@example.com' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().devResetToken).toBeUndefined();
  });
});

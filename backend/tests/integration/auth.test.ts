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
  await prisma.emailVerification.deleteMany();
  await prisma.teamMembership.deleteMany();
  // v1.30.6: also wipe directories so a prior test file's leftovers
  // don't route this file's "unknown user" login through a stale JIT
  // bind path. Cheap; idempotent when empty.
  await prisma.directoryGroupMapping.deleteMany();
  await prisma.directory.deleteMany();
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

  // ── v1.30.5 (S-4): refresh-token family revocation on reuse ──────────
  //
  // Until this release, replaying a refresh token after it had been
  // rotated returned 401 for that one token — but the LIVE sibling that
  // had been issued at rotation kept working. So an attacker who phished
  // a refresh cookie could simply hit /refresh first; the legitimate
  // user's next /refresh would 401, but the attacker now held the only
  // live token in the chain and rode the session indefinitely.
  //
  // Fix: when the DB finds a presented token that's already revoked
  // (someone is replaying a token rotated away), revoke EVERY sibling
  // in the family. Both attacker AND victim die; the legitimate user
  // re-logs-in, which is the right answer when theft is detected.
  describe('S-4 refresh-token family revocation', () => {
    async function registerAndGetCookie(email: string): Promise<string> {
      const reg = await inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { email, name: 'U', password: VALID_PASSWORD },
      });
      const c = reg.cookies.find((x) => x.name === 'th_refresh');
      if (!c) throw new Error(`register failed for ${email}: ${reg.statusCode} ${reg.body}`);
      return c.value;
    }

    async function refreshOnce(cookieValue: string): Promise<{ status: number; nextCookie: string | null }> {
      const res = await inject({
        method: 'POST',
        url: '/api/auth/refresh',
        cookies: { th_refresh: cookieValue },
      });
      const next = res.cookies.find((x) => x.name === 'th_refresh');
      return { status: res.statusCode, nextCookie: next?.value ?? null };
    }

    it('happy path — three consecutive rotations all succeed', async () => {
      let cookie = await registerAndGetCookie('happy@example.com');
      for (let i = 0; i < 3; i++) {
        const r = await refreshOnce(cookie);
        expect(r.status).toBe(200);
        expect(r.nextCookie).not.toBeNull();
        cookie = r.nextCookie!;
      }
      // The whole chain shares one familyId.
      const rows = await prisma.refreshToken.findMany({
        where: { user: { email: 'happy@example.com' } },
        select: { familyId: true },
      });
      const families = new Set(rows.map((r) => r.familyId));
      expect(families.size).toBe(1);
    });

    it('reuse — replaying R1 after R2 was issued revokes the whole family', async () => {
      const R1 = await registerAndGetCookie('reuse@example.com');
      // Rotate R1 → R2.
      const rot = await refreshOnce(R1);
      expect(rot.status).toBe(200);
      const R2 = rot.nextCookie!;

      // Replay R1. Should 401 AND trip family revocation.
      const replay = await refreshOnce(R1);
      expect(replay.status).toBe(401);

      // Critically, R2 — which would otherwise still be valid — must
      // now also be revoked. Its /refresh attempt 401s. Before this
      // patch, R2 kept working.
      const r2Replay = await refreshOnce(R2);
      expect(r2Replay.status).toBe(401);

      // DB-side check: every row in this family is revokedAt-set.
      const rows = await prisma.refreshToken.findMany({
        where: { user: { email: 'reuse@example.com' } },
      });
      expect(rows.length).toBeGreaterThanOrEqual(2);
      for (const row of rows) {
        expect(row.revokedAt).not.toBeNull();
      }
    });

    it('family isolation — two separate logins for the same user create independent families', async () => {
      // Register once (login #1).
      const A = await registerAndGetCookie('two@example.com');

      // Login again — same user, brand-new family.
      const login = await inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'two@example.com', password: VALID_PASSWORD },
      });
      expect(login.statusCode).toBe(200);
      const B = login.cookies.find((x) => x.name === 'th_refresh')!.value;

      // Two distinct families now exist for this user.
      const beforeRows = await prisma.refreshToken.findMany({
        where: { user: { email: 'two@example.com' } },
        select: { familyId: true },
      });
      const beforeFamilies = new Set(beforeRows.map((r) => r.familyId));
      expect(beforeFamilies.size).toBe(2);

      // Force a reuse on family A: rotate A → A2, then replay A.
      const rotA = await refreshOnce(A);
      expect(rotA.status).toBe(200);
      const A2 = rotA.nextCookie!;
      const replayA = await refreshOnce(A);
      expect(replayA.status).toBe(401);
      // Family A is now nuked.
      const replayA2 = await refreshOnce(A2);
      expect(replayA2.status).toBe(401);

      // Family B is untouched and still rotates cleanly.
      const rotB = await refreshOnce(B);
      expect(rotB.status).toBe(200);
      expect(rotB.nextCookie).not.toBeNull();
    });
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

describe('email verification', () => {
  it('register surfaces a dev verification token; perform marks user verified', async () => {
    const reg = await inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'verify@example.com', name: 'V', password: VALID_PASSWORD },
    });
    expect(reg.statusCode).toBe(201);
    const token = reg.json().devVerifyToken as string;
    expect(token).toBeTypeOf('string');

    const verified = await prisma.user.findUnique({ where: { email: 'verify@example.com' } });
    expect(verified?.emailVerifiedAt).toBeNull();

    const perform = await inject({
      method: 'POST',
      url: '/api/auth/verification/perform',
      payload: { token },
    });
    expect(perform.statusCode).toBe(204);

    const after = await prisma.user.findUnique({ where: { email: 'verify@example.com' } });
    expect(after?.emailVerifiedAt).toBeTruthy();
  });

  it('rejects an already-used verification token', async () => {
    const reg = await inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'verify@example.com', name: 'V', password: VALID_PASSWORD },
    });
    const token = reg.json().devVerifyToken as string;
    const first = await inject({
      method: 'POST',
      url: '/api/auth/verification/perform',
      payload: { token },
    });
    expect(first.statusCode).toBe(204);
    const second = await inject({
      method: 'POST',
      url: '/api/auth/verification/perform',
      payload: { token },
    });
    expect(second.statusCode).toBe(400);
  });

  it('does not enumerate on /verification/request for unknown email', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/auth/verification/request',
      payload: { email: 'ghost@example.com' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().devVerifyToken).toBeUndefined();
  });

  it('does not re-issue a token for an already-verified account', async () => {
    const reg = await inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'verify@example.com', name: 'V', password: VALID_PASSWORD },
    });
    const t = reg.json().devVerifyToken as string;
    await inject({ method: 'POST', url: '/api/auth/verification/perform', payload: { token: t } });

    const resend = await inject({
      method: 'POST',
      url: '/api/auth/verification/request',
      payload: { email: 'verify@example.com' },
    });
    expect(resend.statusCode).toBe(202);
    expect(resend.json().devVerifyToken).toBeUndefined();
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';

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

// v1.30.11 (S-9): public self-registration removed. The previous
// 409 "Email already registered" response on a duplicate email was an
// account-enumeration channel — an unauthenticated caller could probe
// any email address and the status code told them whether it existed.
// New accounts come from `prisma db seed` (bootstrap) and the v1.26
// POST /api/admin/users endpoint (everyone else). The block below
// pins the new reality: an unauthenticated probe at the old route
// receives 404 — the route simply does not exist.
describe('POST /api/auth/register removed (S-9)', () => {
  it('returns 404 and CANNOT be used to probe whether an email exists', async () => {
    // Seed an email straight via Prisma so it's definitely there.
    const seeded = await bootstrapUser(app, {
      email: 'definitely-exists@example.com',
      password: VALID_PASSWORD,
    });
    expect(seeded.userId).toBeTruthy();

    const probeExisting = await inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: 'definitely-exists@example.com',
        name: 'X',
        password: VALID_PASSWORD,
      },
    });
    const probeMissing = await inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'not-here@example.com', name: 'X', password: VALID_PASSWORD },
    });
    // Both must look identical (404). The whole point: no
    // information leak between "exists" and "doesn't".
    expect(probeExisting.statusCode).toBe(404);
    expect(probeMissing.statusCode).toBe(404);
    expect(probeExisting.statusCode).toBe(probeMissing.statusCode);
  });
});

describe('POST /api/auth/login', () => {
  beforeEach(async () => {
    // v1.30.11 (S-9): seed the test user via the helper (Prisma direct
    // + login) since /api/auth/register no longer exists.
    await bootstrapUser(app, {
      email: 'a@example.com',
      name: 'Alice',
      password: VALID_PASSWORD,
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
    const seeded = await bootstrapUser(app, {
      email: 'a@example.com',
      name: 'Alice',
      password: VALID_PASSWORD,
    });
    const cookieValue = seeded.refreshCookie!;

    const first = await inject({
      method: 'POST',
      url: '/api/auth/refresh',
      cookies: { th_refresh: cookieValue },
    });
    expect(first.statusCode).toBe(200);

    // Reusing the original refresh cookie should now fail (token revoked).
    const replay = await inject({
      method: 'POST',
      url: '/api/auth/refresh',
      cookies: { th_refresh: cookieValue },
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
      // v1.30.11 (S-9): the public /register endpoint is gone. Bootstrap
      // via the helper (Prisma direct + /login), then return the
      // refresh cookie from the login response — the v1.30.5 family
      // root is established by /login the same way it was by /register.
      const r = await bootstrapUser(app, { email, name: 'U', password: VALID_PASSWORD });
      if (!r.refreshCookie) throw new Error(`bootstrap returned no cookie for ${email}`);
      return r.refreshCookie;
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

    it('reuse — replaying R1 after R2 was issued (outside the grace window) revokes the whole family', async () => {
      // v1.30.10 added a 5-second grace window: an immediate replay
      // looks like a benign client race and 401s without family
      // revocation. To exercise the actual-theft path we backdate the
      // first token's revokedAt past the window before the replay.
      // Before v1.30.10 this test rotated then immediately replayed;
      // v1.30.10 needs the backdate so the replay lands OUTSIDE the
      // window — the original assertion (R2 also revoked) still holds.
      const R1 = await registerAndGetCookie('reuse@example.com');
      // Rotate R1 → R2.
      const rot = await refreshOnce(R1);
      expect(rot.status).toBe(200);
      const R2 = rot.nextCookie!;

      // Backdate R1's revokedAt past the 5s grace window so the next
      // replay is treated as theft rather than a benign race.
      await prisma.refreshToken.updateMany({
        where: { user: { email: 'reuse@example.com' }, revokedAt: { not: null } },
        data: { revokedAt: new Date(Date.now() - 60_000) },
      });

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

    it('within-window replay — a replay <=5s after rotation is treated as a benign race (401, no family revocation)', async () => {
      // v1.30.10 (S-18 / grace window): the operational pain point the
      // v1.30.5 phase boundary flagged. SPA double-tabs and retried
      // fetches that landed just after rotation logged the user out
      // everywhere. The grace window 401s the replay but leaves R2
      // (the sibling rotation produced) fully working — a fresh
      // /refresh on R2 still rotates.
      const R1 = await registerAndGetCookie('within@example.com');
      const rot = await refreshOnce(R1);
      expect(rot.status).toBe(200);
      const R2 = rot.nextCookie!;
      // DON'T backdate — the replay lands inside the 5s window.
      const replay = await refreshOnce(R1);
      expect(replay.status).toBe(401);
      // The sibling token is NOT revoked. Its /refresh rotates cleanly.
      const r2Rotate = await refreshOnce(R2);
      expect(r2Rotate.status).toBe(200);
      // DB-side: R2 is still live (revokedAt null after one more
      // rotation we just did, then revoked — so look at the family
      // and assert at least ONE row was never revoked before the
      // rotation we just performed). Simpler: assert the family was
      // not all-revoked immediately after the within-window replay.
      const livesAfterReplay = await prisma.refreshToken.count({
        where: { user: { email: 'within@example.com' }, revokedAt: null },
      });
      // The most-recent rotation produced a new live token, so the
      // count is at least 1. Crucially it's not zero — which it
      // WOULD be if the family was revoked.
      expect(livesAfterReplay).toBeGreaterThanOrEqual(1);
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
      // v1.30.10 grace window: backdate the revoked sibling so the
      // replay lands OUTSIDE the 5s window and triggers actual family
      // revocation (without the backdate it'd be a benign-race 401
      // and the rest of the assertions would no longer hold).
      const rotA = await refreshOnce(A);
      expect(rotA.status).toBe(200);
      const A2 = rotA.nextCookie!;
      await prisma.refreshToken.updateMany({
        where: { user: { email: 'two@example.com' }, revokedAt: { not: null } },
        data: { revokedAt: new Date(Date.now() - 60_000) },
      });
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
    const { token } = await bootstrapUser(app, {
      email: 'a@example.com',
      name: 'Alice',
      password: VALID_PASSWORD,
    });
    const res = await inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().email).toBe('a@example.com');
  });
});

describe('password reset', () => {
  it('issues a token, accepts it, revokes existing sessions', async () => {
    const seeded = await bootstrapUser(app, {
      email: 'a@example.com',
      name: 'Alice',
      password: VALID_PASSWORD,
    });
    const cookie = { value: seeded.refreshCookie! };

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
  // v1.30.11 (S-9): /register used to surface a `devVerifyToken` for
  // tests. Since the route is gone, tests bootstrap-unverified and
  // pull a fresh token from /verification/request.

  async function requestVerifyToken(email: string): Promise<string> {
    const res = await inject({
      method: 'POST',
      url: '/api/auth/verification/request',
      payload: { email },
    });
    expect(res.statusCode).toBe(202);
    const token = res.json().devVerifyToken as string | undefined;
    if (!token) throw new Error(`no devVerifyToken returned for ${email}`);
    return token;
  }

  it('verification/request surfaces a dev token; perform marks user verified', async () => {
    await bootstrapUser(app, {
      email: 'verify@example.com',
      name: 'V',
      password: VALID_PASSWORD,
      preVerify: false,
    });
    const token = await requestVerifyToken('verify@example.com');

    const before = await prisma.user.findUnique({ where: { email: 'verify@example.com' } });
    expect(before?.emailVerifiedAt).toBeNull();

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
    await bootstrapUser(app, {
      email: 'verify@example.com',
      name: 'V',
      password: VALID_PASSWORD,
      preVerify: false,
    });
    const token = await requestVerifyToken('verify@example.com');
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
    // Pre-verified by default — and the verification request endpoint
    // must NOT surface a fresh token for an already-verified address.
    await bootstrapUser(app, {
      email: 'verify@example.com',
      name: 'V',
      password: VALID_PASSWORD,
    });
    const resend = await inject({
      method: 'POST',
      url: '/api/auth/verification/request',
      payload: { email: 'verify@example.com' },
    });
    expect(resend.statusCode).toBe(202);
    expect(resend.json().devVerifyToken).toBeUndefined();
  });
});

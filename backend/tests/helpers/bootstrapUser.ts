import argon2 from 'argon2';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../../src/data/prisma.js';

// v1.30.11 (S-9): public self-registration was removed because POST
// /api/auth/register's "Email already registered" 409 leaked whether
// a given email existed. Production instances now bootstrap their
// first admin via `prisma db seed` (SEED_ADMIN_EMAIL +
// SEED_ADMIN_PASSWORD) and create subsequent users via the v1.26
// admin-provisioning endpoint.
//
// The 30+ integration tests that previously called /api/auth/register
// as a setup step now go through this helper instead: it creates the
// user row directly via Prisma (same shape the real register service
// produced, minus the email-verification token + verification email),
// then logs them in via POST /api/auth/login to get a real access token.
//
// Why direct Prisma rather than going through /api/admin/users for
// every test:
//   - Tests need to create an ADMIN user first (no admin exists at
//     the start of a fresh test DB), and /api/admin/users requires an
//     admin caller. We'd need a chicken-and-egg bootstrap.
//   - The register service did exactly this insert; mirroring it
//     gives the test suite the same shape.
//   - It's faster — no HTTP roundtrip + no email-verification token
//     creation.

export interface BootstrapResult {
  token: string;
  userId: string;
  email: string;
  // Refresh cookie value. Tests exercising the /refresh rotation
  // path need it; everyone else ignores it. Null only if cookie
  // handling is disabled in the test env.
  refreshCookie: string | null;
}

export interface BootstrapInput {
  email: string;
  name?: string;
  password: string;
  // Override the auto-promotion logic. The real /register service used
  // to promote the first registered user (user count === 0) to ADMIN
  // and everyone else to MEMBER. The helper preserves that default so
  // tests that relied on it keep working — they call bootstrapUser
  // first to seed an admin and subsequent calls produce MEMBERs.
  globalRole?: 'ADMIN' | 'MEMBER';
  // Tests exercising the email-verification flow want a user that
  // ISN'T pre-verified so they can fetch a fresh token via
  // /verification/request. Default true to match the old register-
  // path behaviour (issued an access token immediately).
  preVerify?: boolean;
}

export async function bootstrapUser(
  app: FastifyInstance,
  input: BootstrapInput,
): Promise<BootstrapResult> {
  const globalRole =
    input.globalRole ?? ((await prisma.user.count()) === 0 ? 'ADMIN' : 'MEMBER');
  const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
  const user = await prisma.user.create({
    data: {
      email: input.email,
      name: input.name ?? input.email.split('@')[0]!,
      passwordHash,
      globalRole,
      // Pre-verified by default — the old register service issued a
      // verification token but immediately returned a valid access
      // token too, so tests treated registration as fully effective.
      // Mirror that. Tests exercising the verification flow opt out
      // via `preVerify: false`.
      emailVerifiedAt: input.preVerify === false ? null : new Date(),
    },
  });

  // Log in to mint a real access token + refresh cookie. Going through
  // the live /api/auth/login path means everything that depends on
  // login side-effects (refresh-token rows, audit entries, the v1.30.5
  // family root) still happens correctly.
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: input.email, password: input.password },
  });
  if (login.statusCode !== 200) {
    throw new Error(`bootstrapUser login failed: ${login.statusCode} ${login.body}`);
  }
  const body = login.json() as { accessToken?: string };
  if (!body.accessToken) {
    throw new Error(`bootstrapUser login returned no accessToken: ${login.body}`);
  }
  const refreshCookie = login.cookies.find((c) => c.name === 'th_refresh')?.value ?? null;
  return {
    token: body.accessToken,
    userId: user.id,
    email: user.email,
    refreshCookie,
  };
}

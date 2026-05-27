import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authenticator } from 'otplib';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';

// Full TOTP enrolment + 2-step login + recovery-code path. Uses otplib to
// generate the same TOTP codes the running server expects.

let app: FastifyInstance;

beforeAll(async () => {
  process.env.MASTER_KEY ??= '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
  app = await buildApp(loadEnv());
});

afterAll(async () => {
  if (app) await app.close();
});

beforeEach(async () => {
  await prisma.refreshToken.deleteMany();
  await prisma.recoveryCode.deleteMany();
  await prisma.user.deleteMany();
});

const PASSWORD = 'CorrectHorseBattery9';

async function register(email = 'tfa@example.com'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, name: 'TFA', password: PASSWORD },
  });
  if (res.statusCode !== 201) throw new Error(`register failed: ${res.statusCode} ${res.body}`);
  return res.json().accessToken;
}

async function enrol(accessToken: string): Promise<{ secret: string; recoveryCodes: string[] }> {
  const setupRes = await app.inject({
    method: 'POST',
    url: '/api/auth/2fa/setup',
    headers: { authorization: `Bearer ${accessToken}` },
  });
  expect(setupRes.statusCode).toBe(200);
  const secret = setupRes.json().secret as string;
  const code = authenticator.generate(secret);
  const confirmRes = await app.inject({
    method: 'POST',
    url: '/api/auth/2fa/confirm',
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { secret, code },
  });
  expect(confirmRes.statusCode).toBe(200);
  return { secret, recoveryCodes: confirmRes.json().recoveryCodes };
}

describe('TOTP 2FA', () => {
  it('enrols via /setup → /confirm, returns ten recovery codes, and flips user.totpEnabled', async () => {
    const token = await register();
    const { recoveryCodes } = await enrol(token);
    expect(recoveryCodes).toHaveLength(10);
    expect(recoveryCodes[0]).toMatch(/^[a-f0-9]{4}-[a-f0-9]{4}$/);
    const me = await prisma.user.findUnique({ where: { email: 'tfa@example.com' } });
    expect(me?.totpEnabled).toBe(true);
    expect(me?.totpSecretEnc).toBeTruthy();
  });

  it('rejects /confirm with a wrong code and does not enable', async () => {
    const token = await register();
    const setupRes = await app.inject({
      method: 'POST',
      url: '/api/auth/2fa/setup',
      headers: { authorization: `Bearer ${token}` },
    });
    const secret = setupRes.json().secret as string;
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/2fa/confirm',
      headers: { authorization: `Bearer ${token}` },
      payload: { secret, code: '000000' },
    });
    expect(res.statusCode).toBe(400);
    const me = await prisma.user.findUnique({ where: { email: 'tfa@example.com' } });
    expect(me?.totpEnabled).toBe(false);
  });

  it('login returns pending2fa for a 2FA-enabled user, then completes via /2fa/login', async () => {
    const token = await register();
    const { secret } = await enrol(token);

    const step1 = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'tfa@example.com', password: PASSWORD },
    });
    expect(step1.statusCode).toBe(200);
    const body1 = step1.json();
    expect(body1.pending2fa).toBe(true);
    expect(typeof body1.pendingToken).toBe('string');
    expect(body1.accessToken).toBeUndefined();

    const code = authenticator.generate(secret);
    const step2 = await app.inject({
      method: 'POST',
      url: '/api/auth/2fa/login',
      payload: { pendingToken: body1.pendingToken, code },
    });
    expect(step2.statusCode).toBe(200);
    expect(typeof step2.json().accessToken).toBe('string');
    expect(step2.json().user.totpEnabled).toBe(true);
  });

  it('/2fa/login with the wrong TOTP code returns 401', async () => {
    const token = await register();
    await enrol(token);
    const step1 = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'tfa@example.com', password: PASSWORD },
    });
    const pending = step1.json().pendingToken;
    const step2 = await app.inject({
      method: 'POST',
      url: '/api/auth/2fa/login',
      payload: { pendingToken: pending, code: '000000' },
    });
    expect(step2.statusCode).toBe(401);
  });

  it('a recovery code logs in and burns on first use', async () => {
    const token = await register();
    const { recoveryCodes } = await enrol(token);
    const code = recoveryCodes[0]!;

    const step1 = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'tfa@example.com', password: PASSWORD },
    });
    const pending = step1.json().pendingToken;

    const ok = await app.inject({
      method: 'POST',
      url: '/api/auth/2fa/login',
      payload: { pendingToken: pending, code },
    });
    expect(ok.statusCode).toBe(200);

    // Burn check: same recovery code can't log in twice.
    const step1b = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'tfa@example.com', password: PASSWORD },
    });
    const pending2 = step1b.json().pendingToken;
    const burnt = await app.inject({
      method: 'POST',
      url: '/api/auth/2fa/login',
      payload: { pendingToken: pending2, code },
    });
    expect(burnt.statusCode).toBe(401);
  });

  it('disable wipes secret, totpEnabled, and recovery codes — when proof is valid', async () => {
    const token = await register();
    const { secret } = await enrol(token);

    // Wrong proof rejected.
    const bad = await app.inject({
      method: 'POST',
      url: '/api/auth/2fa/disable',
      headers: { authorization: `Bearer ${token}` },
      payload: { code: '000000' },
    });
    expect(bad.statusCode).toBe(400);

    // Correct proof.
    const ok = await app.inject({
      method: 'POST',
      url: '/api/auth/2fa/disable',
      headers: { authorization: `Bearer ${token}` },
      payload: { code: authenticator.generate(secret) },
    });
    expect(ok.statusCode).toBe(204);

    const me = await prisma.user.findUnique({ where: { email: 'tfa@example.com' } });
    expect(me?.totpEnabled).toBe(false);
    expect(me?.totpSecretEnc).toBeNull();
    expect(await prisma.recoveryCode.count({ where: { userId: me!.id } })).toBe(0);
  });

  it('regenerate recovery codes invalidates the previous set', async () => {
    const token = await register();
    const { recoveryCodes: original } = await enrol(token);

    const regen = await app.inject({
      method: 'POST',
      url: '/api/auth/2fa/recovery-codes',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(regen.statusCode).toBe(200);
    const fresh = regen.json().recoveryCodes as string[];
    expect(fresh).toHaveLength(10);
    expect(fresh).not.toEqual(original);

    // An original code should no longer work.
    const step1 = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'tfa@example.com', password: PASSWORD },
    });
    const denied = await app.inject({
      method: 'POST',
      url: '/api/auth/2fa/login',
      payload: { pendingToken: step1.json().pendingToken, code: original[0]! },
    });
    expect(denied.statusCode).toBe(401);
  });

  // S-3 (v1.30.1): a pending-2FA token must NOT pass requireAuth. The
  // previous implementation reused the access secret for pending tokens and
  // verifyAccess didn't inspect the `kind` claim, so an attacker with a
  // valid password (no second factor) could skip 2FA and even mint an API
  // token via /settings/api-tokens — turning a 5-minute pending window into
  // a long-lived account takeover.
  describe('S-3 regression: pending tokens cannot satisfy requireAuth', () => {
    async function freshPending(): Promise<string> {
      const token = await register('s3@example.com');
      await enrol(token);
      const step1 = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 's3@example.com', password: PASSWORD },
      });
      expect(step1.statusCode).toBe(200);
      const pending = step1.json().pendingToken as string;
      expect(typeof pending).toBe('string');
      return pending;
    }

    it('rejects a pending token on GET /api/auth/me with 401', async () => {
      const pending = await freshPending();
      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${pending}` },
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects a pending token on POST /api/settings/api-tokens with 401 (takeover chain)', async () => {
      const pending = await freshPending();
      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/api-tokens',
        headers: { authorization: `Bearer ${pending}` },
        // v1.30.3 (S-2): the create body now restricts scopes to the
        // vocabulary in lib/scopes.ts. Use a valid string so this test
        // still exercises the auth gate, not the body validator.
        payload: { name: 'should-not-work', scopes: ['tasks:read'] },
      });
      expect(res.statusCode).toBe(401);
    });

    it('still completes the normal flow: pending → /2fa/login → full session works', async () => {
      const userToken = await register('s3flow@example.com');
      const { secret } = await enrol(userToken);
      const step1 = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 's3flow@example.com', password: PASSWORD },
      });
      const pending = step1.json().pendingToken as string;
      expect(typeof pending).toBe('string');

      const step2 = await app.inject({
        method: 'POST',
        url: '/api/auth/2fa/login',
        payload: { pendingToken: pending, code: authenticator.generate(secret) },
      });
      expect(step2.statusCode).toBe(200);
      const access = step2.json().accessToken as string;
      expect(typeof access).toBe('string');

      // The full-session access token works on the same routes the
      // pending token was just denied on.
      const me = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${access}` },
      });
      expect(me.statusCode).toBe(200);
      expect(me.json().email).toBe('s3flow@example.com');
    });
  });

  it('login without 2FA enabled keeps the legacy single-step response shape', async () => {
    await register('local-only@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'local-only@example.com', password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.pending2fa).toBeUndefined();
    expect(typeof body.accessToken).toBe('string');
    expect(body.user.totpEnabled).toBe(false);
  });
});

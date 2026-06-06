import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { updateCheckService } from '../../src/services/updateCheckService.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';

// Integration coverage for GET /api/admin/update-check.
//  - 401 for unauthenticated callers
//  - 403 for non-admin members
//  - enabled=false when UPDATE_CHECK_ENABLED is unset
//  - updateAvailable=true when a higher tag comes back from a mocked fetch
//  - updateAvailable=false when the tag matches the current version
//
// The GitHub fetch is mocked via global.fetch — no network calls, no
// dependency on rate limits, no flake.

let app: FastifyInstance;

beforeAll(async () => {
  const env = loadEnv();
  app = await buildApp(env);
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await prisma.refreshToken.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.user.deleteMany();
  updateCheckService.__resetCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.UPDATE_CHECK_ENABLED;
  delete process.env.TASKHUB_VERSION;
});

const PASSWORD = 'CorrectHorseBattery9';

async function inject(opts: Parameters<FastifyInstance['inject']>[0]) {
  return app.inject(opts);
}

async function registerAdmin(): Promise<string> {
  const r = await bootstrapUser(app, { email: 'a@example.com', name: 'A', password: PASSWORD });
  return r.token;
}

async function registerMember(): Promise<string> {
  // First user is auto-promoted to ADMIN; second is MEMBER.
  await bootstrapUser(app, { email: 'first@example.com', name: 'First', password: PASSWORD });
  const r = await bootstrapUser(app, { email: 'm@example.com', name: 'M', password: PASSWORD });
  return r.token;
}

function stubGithubLatest(tagName: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        tag_name: tagName,
        html_url: `https://github.com/nsrfth/taskhub/releases/tag/${tagName}`,
        published_at: '2026-05-24T00:00:00Z',
      }),
    }),
  );
}

describe('GET /api/admin/update-check', () => {
  it('rejects unauthenticated callers with 401', async () => {
    const res = await inject({ method: 'GET', url: '/api/admin/update-check' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects non-admin members with 403', async () => {
    const memberToken = await registerMember();
    const res = await inject({
      method: 'GET',
      url: '/api/admin/update-check',
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns enabled=false when UPDATE_CHECK_ENABLED is not set', async () => {
    const token = await registerAdmin();
    const res = await inject({
      method: 'GET',
      url: '/api/admin/update-check',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.enabled).toBe(false);
    expect(body.updateAvailable).toBe(false);
    expect(body.latestVersion).toBeNull();
  });

  it('returns updateAvailable=true when the latest GitHub tag is higher', async () => {
    process.env.UPDATE_CHECK_ENABLED = 'true';
    process.env.TASKHUB_VERSION = '1.15.0';
    stubGithubLatest('v1.16.0');

    const token = await registerAdmin();
    const res = await inject({
      method: 'GET',
      url: '/api/admin/update-check',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.enabled).toBe(true);
    expect(body.currentVersion).toBe('1.15.0');
    expect(body.latestVersion).toBe('v1.16.0');
    expect(body.updateAvailable).toBe(true);
    expect(body.releaseUrl).toMatch(/v1\.16\.0$/);
  });

  it('returns updateAvailable=false when the GitHub tag equals the current version', async () => {
    process.env.UPDATE_CHECK_ENABLED = 'true';
    process.env.TASKHUB_VERSION = '1.15.0';
    stubGithubLatest('v1.15.0');

    const token = await registerAdmin();
    const res = await inject({
      method: 'GET',
      url: '/api/admin/update-check',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().updateAvailable).toBe(false);
  });
});

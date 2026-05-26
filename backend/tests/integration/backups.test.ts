import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';

// v1.27: /api/admin/backups routes.
//
// runBackup() shells out to pg_dump which isn't on PATH in the test runner.
// These tests cover the routes that don't require pg_dump:
//   - admin gating (member -> 403)
//   - GET / returns config + empty list
//   - PUT /config persists changes
//   - GET /:filename/download streams a file
//   - DELETE /:filename removes a file + 404 for unknown
//   - filename sanitisation rejects path traversal

let app: FastifyInstance;
let backupDir: string;

beforeAll(async () => {
  backupDir = await fs.mkdtemp(join(tmpdir(), 'taskhub-backup-test-'));
  process.env.BACKUP_DIR = backupDir;
  const env = loadEnv();
  // loadEnv is cached after the first call elsewhere in the suite, so we
  // force BACKUP_DIR on the cached value to be safe.
  (env as { BACKUP_DIR: string }).BACKUP_DIR = backupDir;
  app = await buildApp(env);
});

afterAll(async () => {
  await app.close();
  await fs.rm(backupDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.refreshToken.deleteMany();
  await prisma.rolePermission.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.role.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
  await prisma.instanceSetting.deleteMany();
});

afterEach(async () => {
  // Wipe any synthetic dumps the test wrote so list endpoints stay
  // deterministic across cases.
  const entries = await fs.readdir(backupDir).catch(() => []);
  await Promise.all(entries.map((n) => fs.unlink(join(backupDir, n)).catch(() => undefined)));
});

const PASSWORD = 'CorrectHorseBattery9';

async function setup() {
  const admin = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email: 'admin@example.com', name: 'Admin', password: PASSWORD },
  });
  const adminToken = admin.json().accessToken as string;
  const member = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email: 'mem@example.com', name: 'Mem', password: PASSWORD },
  });
  const memberToken = member.json().accessToken as string;
  return { adminToken, memberToken };
}

async function writeFakeDump(name: string, body = 'fake-dump'): Promise<void> {
  await fs.writeFile(join(backupDir, name), body);
}

describe('/api/admin/backups', () => {
  it('rejects non-admin callers with 403', async () => {
    const { memberToken } = await setup();
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/backups',
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns default config + empty list when nothing is configured', async () => {
    const { adminToken } = await setup();
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/backups',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.config).toEqual({ enabled: false, intervalHours: 24, retention: 7 });
    expect(body.lastRunAt).toBeNull();
    expect(body.nextRunAt).toBeNull();
    expect(body.items).toEqual([]);
  });

  it('PUT /config persists changes + clamps out-of-range values are rejected', async () => {
    const { adminToken } = await setup();
    const ok = await app.inject({
      method: 'PUT',
      url: '/api/admin/backups/config',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { enabled: true, intervalHours: 12, retention: 14 },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ enabled: true, intervalHours: 12, retention: 14 });

    const tooBig = await app.inject({
      method: 'PUT',
      url: '/api/admin/backups/config',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { intervalHours: 99999 },
    });
    expect(tooBig.statusCode).toBe(400);

    // Re-read; the rejected PUT should not have changed state.
    const after = await app.inject({
      method: 'GET',
      url: '/api/admin/backups',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(after.json().config).toEqual({ enabled: true, intervalHours: 12, retention: 14 });
  });

  it('lists dumps written to BACKUP_DIR + serves them for download', async () => {
    const { adminToken } = await setup();
    await writeFakeDump('taskhub-2026-05-26T10-00-00-000Z.dump', 'hello');
    await writeFakeDump('taskhub-2026-05-25T10-00-00-000Z.dump', 'older');
    // Stray non-backup file is ignored.
    await writeFakeDump('README.txt');

    const list = await app.inject({
      method: 'GET',
      url: '/api/admin/backups',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(list.statusCode).toBe(200);
    const items = list.json().items as Array<{ filename: string; sizeBytes: number }>;
    expect(items.map((i) => i.filename)).toEqual([
      'taskhub-2026-05-26T10-00-00-000Z.dump',
      'taskhub-2026-05-25T10-00-00-000Z.dump',
    ]);
    expect(items[0].sizeBytes).toBe(5);

    const dl = await app.inject({
      method: 'GET',
      url: '/api/admin/backups/taskhub-2026-05-26T10-00-00-000Z.dump/download',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(dl.statusCode).toBe(200);
    expect(dl.body).toBe('hello');
    expect(dl.headers['content-disposition']).toContain('taskhub-2026-05-26T10-00-00-000Z.dump');
  });

  it('DELETE removes a dump + 404 for unknown filename', async () => {
    const { adminToken } = await setup();
    await writeFakeDump('taskhub-2026-05-26T10-00-00-000Z.dump');

    const ok = await app.inject({
      method: 'DELETE',
      url: '/api/admin/backups/taskhub-2026-05-26T10-00-00-000Z.dump',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(ok.statusCode).toBe(204);

    const missing = await app.inject({
      method: 'DELETE',
      url: '/api/admin/backups/taskhub-1999-01-01T00-00-00-000Z.dump',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('accepts an admin-uploaded .dump + list/download/delete round-trip', async () => {
    const { adminToken } = await setup();
    // Build a small multipart body by hand — light_my_request handles it.
    const boundary = '----TaskHubBackupTestBoundary';
    const body =
      `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="file"; filename="my external dump.dump"\r\n' +
      'Content-Type: application/octet-stream\r\n\r\n' +
      'pretend-this-is-pg_dump-output\r\n' +
      `--${boundary}--\r\n`;
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/backups/upload',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    const saved = res.json() as { filename: string; sizeBytes: number };
    expect(saved.filename).toMatch(/^upload-.*\.dump$/);
    // Filename should NOT contain the original space (sanitised away).
    expect(saved.filename).not.toContain(' ');
    expect(saved.sizeBytes).toBeGreaterThan(0);

    const list = await app.inject({
      method: 'GET',
      url: '/api/admin/backups',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect((list.json().items as Array<{ filename: string }>).map((i) => i.filename)).toContain(saved.filename);

    // The uploaded file is reachable via the same download endpoint as
    // scheduler-written dumps.
    const dl = await app.inject({
      method: 'GET',
      url: `/api/admin/backups/${saved.filename}/download`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(dl.statusCode).toBe(200);
    expect(dl.body).toBe('pretend-this-is-pg_dump-output');

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/admin/backups/${saved.filename}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(del.statusCode).toBe(204);
  });

  it('restore endpoint 404s when the file is missing', async () => {
    const { adminToken, memberToken } = await setup();
    const member = await app.inject({
      method: 'POST',
      url: '/api/admin/backups/taskhub-1999.dump/restore',
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(member.statusCode).toBe(403);
    const missing = await app.inject({
      method: 'POST',
      url: '/api/admin/backups/taskhub-1999-01-01T00-00-00-000Z.dump/restore',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('rejects path-traversal + non-backup filenames', async () => {
    const { adminToken } = await setup();
    const evil = await app.inject({
      method: 'DELETE',
      // %2e%2e%2fetc%2fpasswd decoded by Fastify before reaching the route
      url: '/api/admin/backups/' + encodeURIComponent('../etc/passwd'),
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(evil.statusCode).toBe(400);

    const wrongShape = await app.inject({
      method: 'DELETE',
      url: '/api/admin/backups/random.txt',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(wrongShape.statusCode).toBe(400);
  });
});

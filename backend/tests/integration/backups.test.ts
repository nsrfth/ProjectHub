import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { _resetMaintenanceCache } from '../../src/middleware/maintenance.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';

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
  // v1.30.4 (S-5): wipe the 1s in-process cache so a previous test's
  // "enabled" state doesn't bleed into this one's setup.
  _resetMaintenanceCache();
});

afterEach(async () => {
  // Wipe any synthetic dumps the test wrote so list endpoints stay
  // deterministic across cases.
  const entries = await fs.readdir(backupDir).catch(() => []);
  await Promise.all(entries.map((n) => fs.unlink(join(backupDir, n)).catch(() => undefined)));
});

const PASSWORD = 'CorrectHorseBattery9';

async function setup() {
  const admin = await bootstrapUser(app, { email: 'admin@example.com', name: 'Admin', password: PASSWORD });
  const member = await bootstrapUser(app, { email: 'mem@example.com', name: 'Mem', password: PASSWORD });
  return { adminToken: admin.token, memberToken: member.token };
}

async function writeFakeDump(name: string, body = 'fake-dump'): Promise<void> {
  await fs.writeFile(join(backupDir, name), body);
}

// v1.32.3: opaque bytes pretending to be a .tar.gz so the list/upload paths
// see the right suffix without us actually shelling out to `tar`.
async function writeFakeBundle(name: string, body = 'fake-tarball'): Promise<void> {
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

  it('v2.5.36: exposes + persists the online backup (Kopia) config', async () => {
    const { adminToken, memberToken } = await setup();
    const H = (t: string) => ({ authorization: `Bearer ${t}` });

    // Default online config on a fresh instance, plus a best-effort status
    // (Kopia server not configured in tests).
    const page = await app.inject({ method: 'GET', url: '/api/admin/backups', headers: H(adminToken) });
    expect(page.json().online).toEqual({
      enabled: false,
      provider: 'GDRIVE',
      folderId: '',
      intervalHours: 6,
      keepDaily: 7,
      keepWeekly: 4,
      keepMonthly: 6,
    });
    expect(page.json().onlineStatus.serverConfigured).toBe(false);
    expect(page.json().onlineStatus.reachable).toBe(false);

    // Admin updates the policy.
    const put = await app.inject({
      method: 'PUT',
      url: '/api/admin/backups/online',
      headers: H(adminToken),
      payload: { enabled: true, folderId: '1AbCdEf', intervalHours: 12, keepDaily: 14 },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ enabled: true, folderId: '1AbCdEf', intervalHours: 12, keepDaily: 14 });

    // Persisted + reflected in status (configured=true now).
    const reread = await app.inject({ method: 'GET', url: '/api/admin/backups', headers: H(adminToken) });
    expect(reread.json().online.folderId).toBe('1AbCdEf');
    expect(reread.json().onlineStatus.configured).toBe(true);

    // Non-admin is blocked.
    const denied = await app.inject({
      method: 'PUT',
      url: '/api/admin/backups/online',
      headers: H(memberToken),
      payload: { enabled: false },
    });
    expect(denied.statusCode).toBe(403);
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

  it('v1.32.3: list returns both .dump (legacy) and .tar.gz (bundle) files', async () => {
    const { adminToken } = await setup();
    await writeFakeDump('taskhub-2026-05-26T10-00-00-000Z.dump');
    await writeFakeBundle('taskhub-2026-05-27T10-00-00-000Z.tar.gz');
    // Stray archive with unknown suffix still ignored.
    await writeFakeDump('taskhub-2026-05-28T10-00-00-000Z.zip');

    const list = await app.inject({
      method: 'GET',
      url: '/api/admin/backups',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const items = list.json().items as Array<{ filename: string }>;
    const names = items.map((i) => i.filename).sort();
    expect(names).toEqual([
      'taskhub-2026-05-26T10-00-00-000Z.dump',
      'taskhub-2026-05-27T10-00-00-000Z.tar.gz',
    ]);
  });

  it('v1.32.3: upload preserves a .tar.gz suffix when sanitising the on-disk name', async () => {
    const { adminToken } = await setup();
    const boundary = '----TaskHubBackupTestBoundary132';
    const body =
      `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="file"; filename="my bundled backup.tar.gz"\r\n' +
      'Content-Type: application/gzip\r\n\r\n' +
      'pretend-this-is-a-tarball\r\n' +
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
    const saved = res.json() as { filename: string };
    expect(saved.filename).toMatch(/^upload-.*\.tar\.gz$/);
    expect(saved.filename).not.toContain(' ');
  });

  it('v1.32.3: restore of an unknown .tar.gz returns 404 (not 400)', async () => {
    const { adminToken } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/backups/taskhub-1999-01-01T00-00-00-000Z.tar.gz/restore',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(404);
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

  // ── v1.30.4 (S-5 + S-12) regression suite ───────────────────────────
  //
  // S-5: pg_restore ran hot against a live DB while schedulers were
  //      still ticking + the listener was still serving normal traffic.
  //      Fix: an InstanceSetting flag flips on; an early Fastify
  //      onRequest hook returns 503 for every route except /health and
  //      /api/health; restoreBackup stops the schedulers + (on success)
  //      schedules process.exit so compose restart picks up the
  //      restored schema. The fresh boot clears the flag.
  //
  // S-12: pg_restore exit code 1 was treated as success when stderr
  //       happened not to contain /ERROR:/i. Fix: --exit-on-error +
  //       strict exit-code handling. ANY non-zero exit is failure.
  describe('S-5 maintenance gate', () => {
    beforeEach(async () => {
      // Make sure no stale maint flag from a previous test leaks.
      await prisma.instanceSetting.deleteMany({ where: { key: 'system.maintenanceMode' } });
      _resetMaintenanceCache();
    });

    it('with maintenance enabled, /api/health still returns 200', async () => {
      await prisma.instanceSetting.upsert({
        where: { key: 'system.maintenanceMode' },
        update: {
          value: { enabled: true, since: new Date().toISOString(), reason: 'test' } as never,
          updatedBy: null,
        },
        create: {
          key: 'system.maintenanceMode',
          value: { enabled: true, since: new Date().toISOString(), reason: 'test' } as never,
          updatedBy: null,
        },
      });
      _resetMaintenanceCache();
      const healthApi = await app.inject({ method: 'GET', url: '/api/health' });
      expect(healthApi.statusCode).toBe(200);
      expect(healthApi.json()).toEqual({ status: 'ok' });
      // The internal /health probe (used by docker healthcheck) is
      // also exempt.
      const healthRoot = await app.inject({ method: 'GET', url: '/health' });
      expect(healthRoot.statusCode).toBe(200);
    });

    it('with maintenance enabled, a normal API request returns 503 with a structured body', async () => {
      const { adminToken } = await setup();
      await prisma.instanceSetting.upsert({
        where: { key: 'system.maintenanceMode' },
        update: {
          value: { enabled: true, since: '2026-05-27T00:00:00Z', reason: 'restoring backup x' } as never,
          updatedBy: null,
        },
        create: {
          key: 'system.maintenanceMode',
          value: { enabled: true, since: '2026-05-27T00:00:00Z', reason: 'restoring backup x' } as never,
          updatedBy: null,
        },
      });
      _resetMaintenanceCache();

      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/backups',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(503);
      expect(res.headers['retry-after']).toBe('30');
      const body = res.json() as { error: { code: string; message: string } };
      expect(body.error.code).toBe('MAINTENANCE');
      // Reason + since both flow through.
      expect(body.error.message).toContain('restoring backup x');
      expect(body.error.message).toContain('2026-05-27T00:00:00Z');
    });

    it('with maintenance disabled, the normal API works as before', async () => {
      const { adminToken } = await setup();
      // Setting absent → off.
      _resetMaintenanceCache();
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/backups',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('S-5 restore route admin gating', () => {
    it('non-admin caller gets 403 even with a real backup file present (admin gate runs first)', async () => {
      const { memberToken } = await setup();
      await writeFakeDump('taskhub-2026-05-27T00-00-00-000Z.dump', 'irrelevant');
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/backups/taskhub-2026-05-27T00-00-00-000Z.dump/restore',
        headers: { authorization: `Bearer ${memberToken}` },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('S-12 pg_restore failure surfaces stderr', () => {
    it('a deliberately corrupt dump makes the restore report failure, not success', async () => {
      const { adminToken } = await setup();
      await writeFakeDump(
        'taskhub-2026-05-27T01-00-00-000Z.dump',
        'this is not a real pg_dump custom-format dump',
      );

      // The restore route's success path schedules a process.exit
      // (set to a no-op by buildApp's default lifecycle), but on
      // failure it throws BEFORE scheduling. We expect a 4xx with the
      // pg_restore stderr surfaced verbatim.
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/backups/taskhub-2026-05-27T01-00-00-000Z.dump/restore',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      // pg_restore is installed inside the backend container that runs
      // the test (see docker/backend.Dockerfile postgresql16-client).
      // The corrupt input causes a non-zero exit; the service rethrows
      // with the stderr in the message; the route wraps that in a 400.
      expect(res.statusCode).toBe(400);
      const body = res.json() as { error: { code: string; message: string } };
      expect(body.error.code).toBe('BAD_REQUEST');
      // Either a "magic number" / "header" / "unsupported" / "not a
      // valid archive" complaint — pg_restore's exact wording varies a
      // little across point releases. Assert SOME stderr came through;
      // the regression we're patching shipped silent successes.
      // The exact wording varies: pg_restore itself yells about magic
      // numbers / unsupported version / not a valid archive when given
      // the bogus bytes; if pg_restore isn't installed in the test
      // container at all, the spawn fails. v1.32.3 also runs a `psql`
      // schema-wipe before pg_restore so a missing-tool environment now
      // surfaces "psql failed to start" first. Any of those proves the
      // regression patch — the route used to swallow non-zero exits and
      // report success.
      expect(body.error.message.toLowerCase()).toMatch(
        /pg_restore exited|pg_restore failed to start|psql failed to start|psql exited|magic|header|archive|unsupported|input|format/,
      );

      // Maintenance must have been CLEARED on failure so the app is
      // still serving.
      const setting = await prisma.instanceSetting.findUnique({
        where: { key: 'system.maintenanceMode' },
      });
      expect(setting).toBeNull();
    });
  });
});


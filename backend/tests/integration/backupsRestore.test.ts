import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { prisma } from '../../src/data/prisma.js';
import { BackupsService, type ProcessRunner } from '../../src/services/backupsService.js';
import { _resetMaintenanceCache } from '../../src/middleware/maintenance.js';
import { bootstrapUser } from '../helpers/bootstrapUser.js';
import { VALID_BUNDLE, buildTarGz, type TarMember } from '../helpers/tarFixtures.js';

// v2.23.3 (S-13): fail-safe restore.
//
// The pre-v2.23.3 flow extracted an unvalidated archive, wiped the live
// schema, and only THEN discovered whether the candidate dump was
// restorable — a corrupt upload left an empty database while the route
// cleared maintenance mode on top of it, so the instance came back up
// serving nothing.
//
// pg_dump / pg_restore / psql / tar are driven through an injected
// ProcessRunner here. That is the only way to observe "pg_restore failed
// halfway" and "the rollback ALSO failed" deterministically — and it
// keeps the suite runnable on hosts without postgresql-client. Archive
// validation is NOT stubbed: the real bytes go through the real parser.

let app: FastifyInstance;
let backupDir: string;
let uploadDir: string;

// Every external command the service runs, in order.
interface Call {
  bin: string;
  args: string[];
}

interface RunnerScenario {
  /** `pg_restore --list` outcome. */
  preflight?: 'ok' | 'fail';
  /** pg_dump (the automatic safety dump) outcome. */
  safetyDump?: 'ok' | 'fail';
  /** psql schema wipe outcome. */
  wipe?: 'ok' | 'fail';
  /** pg_restore of the candidate dump. */
  restore?: 'ok' | 'fail';
  /** pg_restore of the safety dump during rollback. */
  rollback?: 'ok' | 'fail';
  /** What fake `tar -xzf` drops into the staging directory. */
  extract?: (stagingDir: string) => Promise<void>;
}

function makeRunner(scenario: RunnerScenario): { runner: ProcessRunner; calls: Call[] } {
  const calls: Call[] = [];
  const runner: ProcessRunner = {
    async run(bin, args) {
      calls.push({ bin, args });
      if (bin === 'pg_dump') {
        if (scenario.safetyDump === 'fail') throw new Error('pg_dump exited 1: simulated');
        const at = args.indexOf('--file');
        if (at >= 0) await fs.writeFile(args[at + 1]!, 'SAFETY-DUMP-BYTES');
        return;
      }
      if (bin === 'psql') {
        if (scenario.wipe === 'fail') throw new Error('psql exited 1: simulated wipe failure');
        return;
      }
      if (bin === 'tar') {
        const at = args.indexOf('-C');
        if (at >= 0 && scenario.extract) await scenario.extract(args[at + 1]!);
        return;
      }
      throw new Error(`unexpected command ${bin}`);
    },
    async capture(bin, args) {
      calls.push({ bin, args });
      if (bin !== 'pg_restore') throw new Error(`unexpected command ${bin}`);
      if (args[0] === '--list') {
        if (scenario.preflight === 'fail') {
          return {
            ok: false,
            code: 1,
            stderr: 'pg_restore: error: did not find magic string in file header',
          };
        }
        return { ok: true, stdout: ';\n; Archive created at 2026-08-03\n185; 1259 16busy TABLE public Task taskhub\n' };
      }
      const target = args[args.length - 1] ?? '';
      const isRollback = target.includes('pre-restore-');
      const mode = isRollback ? scenario.rollback : scenario.restore;
      if (mode === 'fail') {
        return {
          ok: false,
          code: 1,
          stderr: isRollback
            ? 'pg_restore: error: could not execute query (rollback)'
            : 'pg_restore: error: relation "Task" already exists',
        };
      }
      return { ok: true, stdout: '' };
    },
  };
  return { runner, calls };
}

function serviceWith(scenario: RunnerScenario): { svc: BackupsService; calls: Call[] } {
  const { runner, calls } = makeRunner(scenario);
  const svc = new BackupsService(
    process.env.DATABASE_URL ?? 'postgresql://u:p@localhost:5432/db?schema=public',
    backupDir,
    { uploadDir, runner },
  );
  return { svc, calls };
}

async function writeBundle(name: string, members: TarMember[]): Promise<void> {
  await fs.writeFile(join(backupDir, name), buildTarGz(members));
}

// Fake `tar -xzf` for the happy path: the bundle's declared contents.
async function extractValidBundle(dir: string): Promise<void> {
  await fs.writeFile(join(dir, 'database.dump'), 'PGDMP-ish bytes');
  await fs.writeFile(join(dir, 'manifest.json'), '{"version":1}');
  await fs.writeFile(join(dir, 'secrets.env'), 'MASTER_KEY=deadbeef\n');
  await fs.mkdir(join(dir, 'uploads'), { recursive: true });
  await fs.writeFile(join(dir, 'uploads', 'abc123-file.pdf'), 'blob');
}

async function maintenanceRow(): Promise<unknown> {
  return prisma.instanceSetting.findUnique({ where: { key: 'system.maintenanceMode' } });
}

async function listBackupDir(): Promise<string[]> {
  return (await fs.readdir(backupDir)).sort();
}

async function auditKinds(): Promise<string[]> {
  const rows = await prisma.securityAuditEvent.findMany({ select: { kind: true } });
  return rows.map((r) => r.kind);
}

beforeAll(async () => {
  backupDir = await fs.mkdtemp(join(tmpdir(), 'taskhub-restore-test-'));
  uploadDir = await fs.mkdtemp(join(tmpdir(), 'taskhub-restore-uploads-'));
  process.env.BACKUP_DIR = backupDir;
  const env = loadEnv();
  (env as { BACKUP_DIR: string }).BACKUP_DIR = backupDir;
  (env as { UPLOAD_DIR: string }).UPLOAD_DIR = uploadDir;
  app = await buildApp(env);
});

afterAll(async () => {
  await app.close();
  await fs.rm(backupDir, { recursive: true, force: true });
  await fs.rm(uploadDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.refreshToken.deleteMany();
  await prisma.rolePermission.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.role.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
  await prisma.instanceSetting.deleteMany();
  await prisma.securityAuditEvent.deleteMany();
  _resetMaintenanceCache();
});

afterEach(async () => {
  for (const name of await fs.readdir(backupDir).catch(() => [])) {
    await fs.rm(join(backupDir, name), { recursive: true, force: true }).catch(() => undefined);
  }
});

const PASSWORD = 'CorrectHorseBattery9';

// Build an app whose backups routes use `svc`, so maintenance-mode
// behaviour is observed through the REAL route rather than re-derived.
async function appWith(svc: BackupsService): Promise<FastifyInstance> {
  const env = loadEnv();
  (env as { BACKUP_DIR: string }).BACKUP_DIR = backupDir;
  return buildApp(env, { backupsService: svc });
}

async function adminToken(instance: FastifyInstance): Promise<string> {
  const admin = await bootstrapUser(instance, {
    email: 'admin@example.com',
    name: 'Admin',
    password: PASSWORD,
  });
  return admin.token;
}

async function restoreVia(
  instance: FastifyInstance,
  token: string,
  filename: string,
): Promise<{ statusCode: number; body: Record<string, never> }> {
  const res = await instance.inject({
    method: 'POST',
    url: `/api/admin/backups/${filename}/restore`,
    headers: { authorization: `Bearer ${token}` },
  });
  return { statusCode: res.statusCode, body: res.json() };
}

describe('S-13 archive safety — hostile bundles never reach the schema', () => {
  const HOSTILE: Array<[string, TarMember[], RegExp]> = [
    [
      'path traversal',
      [
        { name: './database.dump', body: 'x' },
        { name: '../../etc/cron.d/pwn', body: '* * * * * root sh' },
      ],
      /escapes the bundle root/i,
    ],
    [
      'a symlink member',
      [
        { name: './database.dump', body: 'x' },
        { name: './uploads/key', type: '2', linkname: '/home/taskhub/.ssh/authorized_keys' },
      ],
      /non-regular member/i,
    ],
    [
      'a hard link member',
      [
        { name: './database.dump', body: 'x' },
        { name: './uploads/shadow', type: '1', linkname: '/etc/shadow' },
      ],
      /non-regular member/i,
    ],
    [
      'an absolute-path member',
      [{ name: './database.dump', body: 'x' }, { name: '/etc/passwd', body: 'x' }],
      /absolute path/i,
    ],
  ];

  for (const [label, members, pattern] of HOSTILE) {
    it(`refuses ${label} before extracting or touching the database`, async () => {
      const { svc, calls } = serviceWith({ extract: extractValidBundle });
      const name = 'upload-2026-08-03T00-00-00-000Z-evil.tar.gz';
      await writeBundle(name, members);

      await expect(svc.restoreBackup(name)).rejects.toMatchObject({
        code: 'BACKUP_ARCHIVE_INVALID',
        statusCode: 400,
      });
      await expect(svc.restoreBackup(name)).rejects.toThrow(pattern);
      // Nothing ran: no extraction, no dump, and above all no wipe.
      expect(calls).toEqual([]);
    });
  }

  it('refuses a bundle with no database.dump before touching the database', async () => {
    const { svc, calls } = serviceWith({ extract: extractValidBundle });
    const name = 'upload-2026-08-03T00-00-00-000Z-nodump.tar.gz';
    await writeBundle(name, [
      { name: './', type: '5' },
      { name: './manifest.json', body: '{}' },
    ]);
    await expect(svc.restoreBackup(name)).rejects.toMatchObject({
      code: 'BACKUP_ARCHIVE_INVALID',
    });
    expect(calls).toEqual([]);
  });

  it('extracts with ownership and permission restoration disabled', async () => {
    const { svc, calls } = serviceWith({ extract: extractValidBundle });
    const name = 'taskhub-2026-08-03T00-00-00-000Z.tar.gz';
    await writeBundle(name, VALID_BUNDLE);
    await svc.restoreBackup(name);
    const tarCall = calls.find((c) => c.bin === 'tar');
    expect(tarCall).toBeDefined();
    expect(tarCall!.args).toContain('--no-same-owner');
    expect(tarCall!.args).toContain('--no-same-permissions');
  });
});

describe('S-13 restore ordering — validate, preflight, safety-dump, THEN wipe', () => {
  it('a dump that fails preflight never wipes the schema', async () => {
    const { svc, calls } = serviceWith({ preflight: 'fail' });
    const name = 'upload-2026-08-03T00-00-00-000Z-corrupt.dump';
    await fs.writeFile(join(backupDir, name), 'this is not a pg_dump archive');

    await expect(svc.restoreBackup(name)).rejects.toThrow(/preflight, database untouched/i);
    expect(calls.map((c) => c.bin)).toEqual(['pg_restore']);
    expect(calls.some((c) => c.bin === 'psql')).toBe(false);
    expect(calls.some((c) => c.bin === 'pg_dump')).toBe(false);
  });

  it('an empty dump file is refused without running anything', async () => {
    const { svc, calls } = serviceWith({});
    const name = 'upload-2026-08-03T00-00-00-000Z-empty.dump';
    await fs.writeFile(join(backupDir, name), '');
    await expect(svc.restoreBackup(name)).rejects.toMatchObject({
      code: 'BACKUP_ARCHIVE_INVALID',
    });
    expect(calls).toEqual([]);
  });

  it('refuses to restore when the safety dump cannot be taken', async () => {
    const { svc, calls } = serviceWith({ safetyDump: 'fail' });
    const name = 'upload-2026-08-03T00-00-00-000Z-ok.dump';
    await fs.writeFile(join(backupDir, name), 'dump bytes');
    await expect(svc.restoreBackup(name)).rejects.toThrow(/safety dump/i);
    // pg_restore --list ran, pg_dump failed, and the wipe never happened.
    expect(calls.map((c) => c.bin)).toEqual(['pg_restore', 'pg_dump']);
  });

  it('a successful restore runs preflight → safety dump → wipe → restore, in that order', async () => {
    const { svc, calls } = serviceWith({});
    const name = 'taskhub-2026-08-03T00-00-00-000Z.dump';
    await fs.writeFile(join(backupDir, name), 'dump bytes');
    const result = await svc.restoreBackup(name);
    expect(calls.map((c) => c.bin)).toEqual(['pg_restore', 'pg_dump', 'psql', 'pg_restore']);
    expect(calls[0]!.args[0]).toBe('--list');
    expect(result.safetyDump).toMatch(/^pre-restore-.*\.dump$/);
    // The safety dump is retained on disk next to the backups.
    expect(await listBackupDir()).toContain(result.safetyDump!);
    expect(result.warnings).toEqual([]);
  });

  it('restores a valid .tar.gz bundle end to end, including uploads and the secrets sidecar', async () => {
    const { svc } = serviceWith({ extract: extractValidBundle });
    const name = 'taskhub-2026-08-03T01-00-00-000Z.tar.gz';
    await writeBundle(name, VALID_BUNDLE);
    await fs.writeFile(join(uploadDir, 'stale-attachment.bin'), 'old');

    const result = await svc.restoreBackup(name);
    expect(result.uploadsRestored).toBe(true);
    expect(result.secretsApplied).toBe(true);
    expect(result.secretsSidecar).toBe('restored-secrets.env');
    expect(result.warnings).toEqual([]);
    // UPLOAD_DIR was replaced by the bundle's contents.
    expect(await fs.readdir(uploadDir)).toEqual(['abc123-file.pdf']);
    expect(await listBackupDir()).toContain('restored-secrets.env');
  });

  it('surfaces an upload-copy failure as a warning instead of swallowing it', async () => {
    // UPLOAD_DIR points at a regular FILE: mkdir/cp inside it must fail.
    const brokenUploadDir = join(await fs.mkdtemp(join(tmpdir(), 'taskhub-broken-')), 'not-a-dir');
    await fs.writeFile(brokenUploadDir, 'i am a file');
    const { runner } = makeRunner({ extract: extractValidBundle });
    const svc = new BackupsService(
      process.env.DATABASE_URL ?? 'postgresql://u:p@localhost:5432/db?schema=public',
      backupDir,
      { uploadDir: brokenUploadDir, runner },
    );
    const name = 'taskhub-2026-08-03T02-00-00-000Z.tar.gz';
    await writeBundle(name, VALID_BUNDLE);

    const result = await svc.restoreBackup(name);
    expect(result.uploadsRestored).toBe(false);
    expect(result.warnings.join(' ')).toMatch(/copying uploads/i);
  });
});

describe('S-13 rollback — a failed restore puts the database back', () => {
  it('rolls back to the safety dump when pg_restore fails', async () => {
    const { svc, calls } = serviceWith({ restore: 'fail' });
    const name = 'upload-2026-08-03T00-00-00-000Z-bad.dump';
    await fs.writeFile(join(backupDir, name), 'dump bytes');

    await expect(svc.restoreBackup(name)).rejects.toMatchObject({
      code: 'RESTORE_ROLLED_BACK',
    });
    // preflight, safety dump, wipe, failed restore, wipe again, rollback restore
    expect(calls.map((c) => c.bin)).toEqual([
      'pg_restore',
      'pg_dump',
      'psql',
      'pg_restore',
      'psql',
      'pg_restore',
    ]);
    // The rollback fed pg_restore the safety dump.
    expect(calls[5]!.args[calls[5]!.args.length - 1]).toMatch(/pre-restore-.*\.dump$/);
    expect(await auditKinds()).toContain('backup.restore.rolled_back');
  });

  it('reports RESTORE_FATAL with the recovery artefacts when the rollback also fails', async () => {
    const { svc } = serviceWith({ restore: 'fail', rollback: 'fail' });
    const name = 'upload-2026-08-03T00-00-00-000Z-bad2.dump';
    await fs.writeFile(join(backupDir, name), 'dump bytes');

    await expect(svc.restoreBackup(name)).rejects.toMatchObject({ code: 'RESTORE_FATAL' });
    await expect(svc.restoreBackup(name)).rejects.toThrow(/pre-restore-/);
    expect(await auditKinds()).toContain('backup.restore.fatal');
    // The safety dump survives for the human who has to use it.
    expect((await listBackupDir()).some((f) => f.startsWith('pre-restore-'))).toBe(true);
  });
});

describe('S-13 maintenance mode follows the restore outcome', () => {
  it('is cleared after a successful restore', async () => {
    const { svc } = serviceWith({});
    const instance = await appWith(svc);
    try {
      const token = await adminToken(instance);
      const name = 'taskhub-2026-08-03T03-00-00-000Z.dump';
      await fs.writeFile(join(backupDir, name), 'dump bytes');
      const res = await restoreVia(instance, token, name);
      expect(res.statusCode).toBe(200);
      expect(await maintenanceRow()).toBeNull();
    } finally {
      await instance.close();
    }
  });

  it('is cleared after a rollback that succeeded', async () => {
    const { svc } = serviceWith({ restore: 'fail' });
    const instance = await appWith(svc);
    try {
      const token = await adminToken(instance);
      const name = 'upload-2026-08-03T04-00-00-000Z-bad.dump';
      await fs.writeFile(join(backupDir, name), 'dump bytes');
      const res = await restoreVia(instance, token, name);
      expect(res.statusCode).toBe(500);
      expect((res.body as unknown as { error: { code: string } }).error.code).toBe(
        'RESTORE_ROLLED_BACK',
      );
      expect(await maintenanceRow()).toBeNull();
    } finally {
      await instance.close();
    }
  });

  it('STAYS ENABLED when the restore and the rollback both fail', async () => {
    const { svc } = serviceWith({ restore: 'fail', rollback: 'fail' });
    const instance = await appWith(svc);
    try {
      const token = await adminToken(instance);
      const name = 'upload-2026-08-03T05-00-00-000Z-bad.dump';
      await fs.writeFile(join(backupDir, name), 'dump bytes');
      const res = await restoreVia(instance, token, name);
      expect(res.statusCode).toBe(500);
      expect((res.body as unknown as { error: { code: string } }).error.code).toBe('RESTORE_FATAL');
      // The whole point: a half-restored schema must not go back into
      // service just because the request finished.
      expect(await maintenanceRow()).not.toBeNull();
      // And the operator is told where the recovery artefact is.
      expect((res.body as unknown as { error: { message: string } }).error.message).toMatch(
        /pre-restore-/,
      );
    } finally {
      // Leave the flag off for the next test file.
      await prisma.instanceSetting.deleteMany({ where: { key: 'system.maintenanceMode' } });
      _resetMaintenanceCache();
      await instance.close();
    }
  });

  it('is cleared when a hostile archive is rejected', async () => {
    const { svc } = serviceWith({ extract: extractValidBundle });
    const instance = await appWith(svc);
    try {
      const token = await adminToken(instance);
      const name = 'upload-2026-08-03T06-00-00-000Z-evil.tar.gz';
      await writeBundle(name, [
        { name: './database.dump', body: 'x' },
        { name: '../../etc/cron.d/pwn', body: 'x' },
      ]);
      const res = await restoreVia(instance, token, name);
      expect(res.statusCode).toBe(400);
      expect((res.body as unknown as { error: { code: string } }).error.code).toBe(
        'BACKUP_ARCHIVE_INVALID',
      );
      expect(await maintenanceRow()).toBeNull();
    } finally {
      await instance.close();
    }
  });
});

import { spawn } from 'node:child_process';
import { promises as fs, createReadStream } from 'node:fs';
import { join, basename } from 'node:path';
import { Errors } from '../lib/errors.js';
import { prisma } from '../data/prisma.js';

// v1.27: automatic Postgres backups via pg_dump.
//
// Why pg_dump (not WAL streaming): single-instance self-hosted deploys are
// the target. A nightly logical dump is the boring, restore-anywhere choice.
// We use --format=custom so admins can restore selective tables later and
// the output is already compressed.
//
// State lives in two places:
//   - InstanceSetting key "backup.config" — admin-tunable enabled/period/retention
//   - InstanceSetting key "backup.lastRunAt" — ISO timestamp of the last
//     successful dump; the scheduler uses this to decide whether a tick is
//     due rather than tracking last-run in memory (so a backend restart
//     doesn't reset the clock).
//
// File naming: taskhub-{ISO timestamp, ':' → '-'}.dump. Sorts lexically by
// time, easy to grep, no other taskhub-* lives in BACKUP_DIR.

export interface BackupConfig {
  enabled: boolean;
  intervalHours: number;
  retention: number;
}

export interface BackupFile {
  filename: string;
  sizeBytes: number;
  createdAt: string;
}

export interface BackupRunResult {
  filename: string;
  sizeBytes: number;
  durationMs: number;
}

const CONFIG_KEY = 'backup.config';
const LAST_RUN_KEY = 'backup.lastRunAt';
const FILE_PREFIX = 'taskhub-';
const FILE_SUFFIX = '.dump';

const MIN_INTERVAL_HOURS = 1;
const MAX_INTERVAL_HOURS = 24 * 30; // 30 days
const MIN_RETENTION = 1;
const MAX_RETENTION = 365;

export const DEFAULT_BACKUP_CONFIG: BackupConfig = {
  enabled: false,
  intervalHours: 24,
  retention: 7,
};

export class BackupsService {
  constructor(
    private readonly databaseUrl: string,
    private readonly backupDir: string,
  ) {}

  async getConfig(): Promise<BackupConfig> {
    const row = await prisma.instanceSetting.findUnique({ where: { key: CONFIG_KEY } });
    if (!row) return { ...DEFAULT_BACKUP_CONFIG };
    return normaliseConfig(row.value);
  }

  async setConfig(input: Partial<BackupConfig>, actorId: string): Promise<BackupConfig> {
    const current = await this.getConfig();
    const next = normaliseConfig({ ...current, ...input });
    await prisma.instanceSetting.upsert({
      where: { key: CONFIG_KEY },
      update: { value: next as never, updatedBy: actorId },
      create: { key: CONFIG_KEY, value: next as never, updatedBy: actorId },
    });
    return next;
  }

  async getLastRunAt(): Promise<Date | null> {
    const row = await prisma.instanceSetting.findUnique({ where: { key: LAST_RUN_KEY } });
    if (!row || typeof row.value !== 'string') return null;
    const d = new Date(row.value);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  private async setLastRunAt(when: Date): Promise<void> {
    await prisma.instanceSetting.upsert({
      where: { key: LAST_RUN_KEY },
      update: { value: when.toISOString() as never, updatedBy: null },
      create: { key: LAST_RUN_KEY, value: when.toISOString() as never, updatedBy: null },
    });
  }

  async list(): Promise<BackupFile[]> {
    await fs.mkdir(this.backupDir, { recursive: true });
    const entries = await fs.readdir(this.backupDir);
    const matches = entries.filter((n) => n.startsWith(FILE_PREFIX) && n.endsWith(FILE_SUFFIX));
    const out: BackupFile[] = [];
    for (const name of matches) {
      try {
        const st = await fs.stat(join(this.backupDir, name));
        if (!st.isFile()) continue;
        out.push({
          filename: name,
          sizeBytes: st.size,
          createdAt: st.mtime.toISOString(),
        });
      } catch {
        // Race against deletion; just skip.
      }
    }
    // Newest first — admins read this top-down.
    out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return out;
  }

  async runBackup(): Promise<BackupRunResult> {
    await fs.mkdir(this.backupDir, { recursive: true });
    const startedAt = new Date();
    // Colons aren't legal in Windows filenames + are annoying on most shells.
    const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
    const filename = `${FILE_PREFIX}${stamp}${FILE_SUFFIX}`;
    const fullPath = join(this.backupDir, filename);

    // pg_dump --format=custom writes a binary compressed dump. --no-owner /
    // --no-acl keep the dump portable so it can be restored into a freshly
    // provisioned database with different role names.
    //
    // libpq-style URI rejects Prisma's `?schema=public` query param ("invalid
    // URI query parameter"). Strip Prisma-specific knobs + lift `schema` into
    // a real pg_dump --schema flag.
    const { connectionUrl, schema } = cleanPrismaUrl(this.databaseUrl);
    const args = ['--format=custom', '--no-owner', '--no-acl'];
    if (schema) args.push('--schema', schema);
    args.push('--file', fullPath, connectionUrl);
    await new Promise<void>((resolve, reject) => {
      const child = spawn('pg_dump', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (b) => {
        stderr += b.toString();
      });
      child.on('error', (err) => {
        reject(new Error(`pg_dump failed to start: ${err.message}`));
      });
      child.on('close', (code) => {
        if (code === 0) return resolve();
        reject(new Error(`pg_dump exited ${code}: ${stderr.trim() || 'unknown error'}`));
      });
    });

    const st = await fs.stat(fullPath);
    await this.setLastRunAt(startedAt);
    await this.applyRetention();
    return {
      filename,
      sizeBytes: st.size,
      durationMs: Date.now() - startedAt.getTime(),
    };
  }

  async deleteBackup(filename: string): Promise<void> {
    const safe = sanitiseFilename(filename);
    const fullPath = join(this.backupDir, safe);
    try {
      await fs.unlink(fullPath);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') throw Errors.notFound('Backup not found');
      throw err;
    }
  }

  async openForDownload(filename: string): Promise<{ stream: NodeJS.ReadableStream; sizeBytes: number; filename: string }> {
    const safe = sanitiseFilename(filename);
    const fullPath = join(this.backupDir, safe);
    let st;
    try {
      st = await fs.stat(fullPath);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') throw Errors.notFound('Backup not found');
      throw err;
    }
    if (!st.isFile()) throw Errors.notFound('Backup not found');
    return { stream: createReadStream(fullPath), sizeBytes: st.size, filename: safe };
  }

  private async applyRetention(): Promise<number> {
    const cfg = await this.getConfig();
    const files = await this.list();
    if (files.length <= cfg.retention) return 0;
    const stale = files.slice(cfg.retention);
    let removed = 0;
    for (const f of stale) {
      try {
        await fs.unlink(join(this.backupDir, f.filename));
        removed += 1;
      } catch {
        // Treat as best-effort; next tick will retry.
      }
    }
    return removed;
  }
}

function normaliseConfig(input: unknown): BackupConfig {
  const v = (input ?? {}) as Record<string, unknown>;
  const enabled = typeof v.enabled === 'boolean' ? v.enabled : DEFAULT_BACKUP_CONFIG.enabled;
  const rawInterval = Number(v.intervalHours);
  const intervalHours = Number.isFinite(rawInterval)
    ? clamp(Math.round(rawInterval), MIN_INTERVAL_HOURS, MAX_INTERVAL_HOURS)
    : DEFAULT_BACKUP_CONFIG.intervalHours;
  const rawRetention = Number(v.retention);
  const retention = Number.isFinite(rawRetention)
    ? clamp(Math.round(rawRetention), MIN_RETENTION, MAX_RETENTION)
    : DEFAULT_BACKUP_CONFIG.retention;
  return { enabled, intervalHours, retention };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

// Prisma decorates DATABASE_URL with `?schema=public` + sometimes
// `&connection_limit=…`. libpq (the URL parser pg_dump uses) rejects unknown
// query params with "invalid URI query parameter". Strip Prisma-specific
// extras + return the schema separately so the caller can pass it via the
// proper --schema flag.
function cleanPrismaUrl(raw: string): { connectionUrl: string; schema: string | null } {
  try {
    const u = new URL(raw);
    const schema = u.searchParams.get('schema');
    // Whitelist the few libpq params we might legitimately want to keep
    // (e.g. sslmode); everything else is Prisma-side and would break pg_dump.
    const LIBPQ_OK = new Set([
      'sslmode',
      'sslcert',
      'sslkey',
      'sslrootcert',
      'host',
      'hostaddr',
      'port',
      'dbname',
      'user',
      'password',
      'connect_timeout',
      'application_name',
    ]);
    for (const key of [...u.searchParams.keys()]) {
      if (!LIBPQ_OK.has(key)) u.searchParams.delete(key);
    }
    return { connectionUrl: u.toString(), schema };
  } catch {
    // If it isn't URL-parseable, hand it through unchanged — pg_dump will
    // surface a clearer error than we can.
    return { connectionUrl: raw, schema: null };
  }
}

// pg_dump dumps go straight to disk in BACKUP_DIR, but the API surfaces the
// filename to the client. Reject path traversal + anything outside the
// known prefix/suffix shape so a hand-crafted DELETE can't unlink arbitrary
// files inside the container.
function sanitiseFilename(name: string): string {
  const bare = basename(name);
  if (bare !== name) throw Errors.badRequest('Invalid backup filename');
  if (!bare.startsWith(FILE_PREFIX) || !bare.endsWith(FILE_SUFFIX)) {
    throw Errors.badRequest('Invalid backup filename');
  }
  if (bare.includes('/') || bare.includes('\\') || bare.includes('..')) {
    throw Errors.badRequest('Invalid backup filename');
  }
  return bare;
}

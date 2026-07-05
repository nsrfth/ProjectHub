import { spawn } from 'node:child_process';
import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { Errors } from '../lib/errors.js';
import { prisma } from '../data/prisma.js';

// v1.32.3: optional bundle of secrets to include in the all-in-one tarball
// format. None of these are required; the legacy `.dump`-only format is
// still produced (just by setting includeUploads/includeSecrets to false).
export interface BackupsServiceConfig {
  uploadDir?: string;
  secrets?: {
    masterKey?: string | null;
    jwtAccessSecret?: string | null;
    jwtRefreshSecret?: string | null;
  };
  // v2.5.36: Kopia server coordinates for the online-backup status ping.
  kopia?: {
    url?: string | null;
    username?: string | null;
    password?: string | null;
    // v2.5.37: shared volume the app writes SA key / password / triggers to and
    // reads status.json from.
    secretsDir?: string | null;
  };
}

// v2.5.36: online backup (Kopia → Google Drive) policy.
export interface OnlineBackupConfig {
  enabled: boolean;
  provider: 'GDRIVE';
  folderId: string;
  intervalHours: number;
  keepDaily: number;
  keepWeekly: number;
  keepMonthly: number;
}

export interface OnlineBackupStatus {
  configured: boolean;
  serviceAccountUploaded: boolean;
  passwordSet: boolean;
  initialized: boolean;
  reachable: boolean;
  lastSnapshotAt: string | null;
  snapshotCount: number;
  error: string | null;
  detail: string | null;
}

export const DEFAULT_ONLINE_BACKUP_CONFIG: OnlineBackupConfig = {
  enabled: false,
  provider: 'GDRIVE',
  folderId: '',
  intervalHours: 6,
  keepDaily: 7,
  keepWeekly: 4,
  keepMonthly: 6,
};

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
// v2.5.36: online backup (Kopia) policy, admin-set from Settings → Backups.
const ONLINE_CONFIG_KEY = 'backup.online';
const ONLINE_POLICY_FILENAME = 'online-backup.json';
const FILE_PREFIX = 'taskhub-';
// v1.32.3: backups now ship as `.tar.gz` containing database.dump + uploads/
// + secrets.env + manifest.json. `.dump` files (legacy + admin uploads from
// older instances) still restore through the same endpoint — the restore
// flow detects format from the filename suffix.
const FILE_SUFFIX_LEGACY = '.dump';
const FILE_SUFFIX_BUNDLE = '.tar.gz';
const ACCEPTED_SUFFIXES = [FILE_SUFFIX_LEGACY, FILE_SUFFIX_BUNDLE] as const;
// Sidecar written after a bundled restore: the secrets that were inside the
// tarball, in `KEY=value` form. The operator copies these into `.env` and
// restarts the backend — we can't apply them from within the running
// process (env is read once at boot).
const RESTORED_SECRETS_FILENAME = 'restored-secrets.env';

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
  private readonly uploadDir: string | null;
  private readonly secrets: BackupsServiceConfig['secrets'];
  private readonly kopia: BackupsServiceConfig['kopia'];

  constructor(
    private readonly databaseUrl: string,
    private readonly backupDir: string,
    config: BackupsServiceConfig = {},
  ) {
    this.uploadDir = config.uploadDir ?? null;
    this.secrets = config.secrets;
    this.kopia = config.kopia;
  }

  // v1.32.3: bundled backups carry these alongside the DB so cross-server
  // restores don't silently break 2FA secrets / LDAP bind passwords (which
  // are encrypted with MASTER_KEY) or invalidate every refresh token
  // (which is signed with the JWT secrets). Returns false when nothing
  // useful is available — the operator's env wasn't passed in (tests).
  private hasSecrets(): boolean {
    return !!(this.secrets?.masterKey || this.secrets?.jwtAccessSecret || this.secrets?.jwtRefreshSecret);
  }

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

  // Expose the secrets-sidecar filename so the route/CHANGELOG can refer to
  // it by symbol without re-deriving the constant.
  // eslint-disable-next-line class-methods-use-this
  get secretsSidecarFilename(): string {
    return RESTORED_SECRETS_FILENAME;
  }

  // --- v2.5.36: online backup (Kopia → Google Drive) ----------------------

  async getOnlineConfig(): Promise<OnlineBackupConfig> {
    const row = await prisma.instanceSetting.findUnique({ where: { key: ONLINE_CONFIG_KEY } });
    if (!row) return { ...DEFAULT_ONLINE_BACKUP_CONFIG };
    return normaliseOnlineConfig(row.value);
  }

  async setOnlineConfig(
    input: Partial<OnlineBackupConfig>,
    actorId: string,
  ): Promise<OnlineBackupConfig> {
    const current = await this.getOnlineConfig();
    const next = normaliseOnlineConfig({ ...current, ...input });
    await prisma.instanceSetting.upsert({
      where: { key: ONLINE_CONFIG_KEY },
      update: { value: next as never, updatedBy: actorId },
      create: { key: ONLINE_CONFIG_KEY, value: next as never, updatedBy: actorId },
    });
    // Mirror the policy onto the shared backups volume so `kopia-setup.sh` can
    // apply it to the Kopia repository without the admin re-typing values.
    await this.writeOnlinePolicyFile(next).catch(() => {
      /* best-effort; the DB row is the source of truth */
    });
    return next;
  }

  private async writeOnlinePolicyFile(cfg: OnlineBackupConfig): Promise<void> {
    await fs.mkdir(this.backupDir, { recursive: true });
    await fs.writeFile(
      join(this.backupDir, ONLINE_POLICY_FILENAME),
      JSON.stringify(cfg, null, 2),
      'utf8',
    );
  }

  private get kopiaSecretsDir(): string | null {
    return this.kopia?.secretsDir ?? null;
  }

  private async fileExists(p: string): Promise<boolean> {
    return fs
      .access(p)
      .then(() => true)
      .catch(() => false);
  }

  // v2.5.37: store the uploaded Google service-account key on the shared volume
  // the Kopia entrypoint reads. Validates it parses as JSON first.
  async saveServiceAccount(bytes: Buffer): Promise<void> {
    const dir = this.kopiaSecretsDir;
    if (!dir) throw Errors.badRequest('Online backup storage is not available on this instance.');
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw Errors.badRequest('The service-account key must be a valid JSON file.');
    }
    if (!parsed || typeof parsed !== 'object' || !('client_email' in (parsed as object))) {
      throw Errors.badRequest('That does not look like a Google service-account key (no client_email).');
    }
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'kopia-gdrive-sa.json'), bytes, { mode: 0o600 });
  }

  // v2.5.37: store the repository encryption password on the shared volume.
  async setRepoPassword(password: string): Promise<void> {
    const dir = this.kopiaSecretsDir;
    if (!dir) throw Errors.badRequest('Online backup storage is not available on this instance.');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'repo-password'), password, { mode: 0o600 });
  }

  // v2.5.37: drop a trigger file the Kopia entrypoint reconciles on.
  private async writeTrigger(name: 'reinit' | 'backup-now'): Promise<void> {
    const dir = this.kopiaSecretsDir;
    if (!dir) throw Errors.badRequest('Online backup storage is not available on this instance.');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, name), new Date().toISOString(), 'utf8');
  }

  async triggerInitialize(): Promise<void> {
    await this.writeTrigger('reinit');
  }

  async triggerBackupNow(): Promise<void> {
    await this.writeTrigger('backup-now');
  }

  // Status: combines what the app knows (config + which secrets are present)
  // with what the Kopia entrypoint reports in status.json, plus a reachability
  // ping. Never throws.
  async getOnlineStatus(): Promise<OnlineBackupStatus> {
    const cfg = await this.getOnlineConfig();
    const dir = this.kopiaSecretsDir;
    const configured = cfg.enabled && cfg.folderId.trim().length > 0;

    let serviceAccountUploaded = false;
    let passwordSet = false;
    let initialized = false;
    let lastSnapshotAt: string | null = null;
    let snapshotCount = 0;
    let error: string | null = null;

    if (dir) {
      serviceAccountUploaded = await this.fileExists(join(dir, 'kopia-gdrive-sa.json'));
      passwordSet = await this.fileExists(join(dir, 'repo-password'));
      try {
        const raw = await fs.readFile(join(dir, 'status.json'), 'utf8');
        const s = JSON.parse(raw) as Record<string, unknown>;
        initialized = s.initialized === true;
        lastSnapshotAt = typeof s.lastSnapshotAt === 'string' ? s.lastSnapshotAt : null;
        snapshotCount = Number.isFinite(Number(s.snapshotCount)) ? Number(s.snapshotCount) : 0;
        error = typeof s.error === 'string' ? s.error : null;
      } catch {
        /* no status yet — the entrypoint hasn't written one */
      }
    }

    const reachable = await this.pingKopia();

    let detail: string;
    if (!serviceAccountUploaded || !passwordSet) detail = 'Upload the Google service-account key and set the repository password to begin.';
    else if (!configured) detail = 'Set the Google Drive folder and enable online backup.';
    else if (error) detail = error;
    else if (initialized) detail = 'Connected — Google Drive repository ready.';
    else if (reachable) detail = 'Kopia service running — initialising…';
    else detail = 'Start the backup service (docker compose --profile backup up -d kopia) to apply this config.';

    return {
      configured,
      serviceAccountUploaded,
      passwordSet,
      initialized,
      reachable,
      lastSnapshotAt,
      snapshotCount,
      error,
      detail,
    };
  }

  private async pingKopia(): Promise<boolean> {
    const url = this.kopia?.url ?? null;
    if (!url) return false;
    try {
      const headers: Record<string, string> = {};
      if (this.kopia?.username && this.kopia?.password) {
        const token = Buffer.from(`${this.kopia.username}:${this.kopia.password}`).toString('base64');
        headers.Authorization = `Basic ${token}`;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      const res = await fetch(`${url.replace(/\/+$/, '')}/api/v1/repo/status`, {
        headers,
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
      return res.ok;
    } catch {
      return false;
    }
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
    const matches = entries.filter(
      (n) =>
        (n.startsWith(FILE_PREFIX) || n.startsWith(UPLOAD_PREFIX)) &&
        ACCEPTED_SUFFIXES.some((s) => n.endsWith(s)),
    );
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

    // v1.32.3: if we have something extra to bundle (uploads or secrets),
    // write a .tar.gz containing database.dump + uploads/ + secrets.env +
    // manifest.json. Otherwise fall back to the legacy single-file .dump
    // so test environments that don't pass env+upload still work.
    const bundle = !!this.uploadDir || this.hasSecrets();
    const filename = bundle
      ? `${FILE_PREFIX}${stamp}${FILE_SUFFIX_BUNDLE}`
      : `${FILE_PREFIX}${stamp}${FILE_SUFFIX_LEGACY}`;
    const fullPath = join(this.backupDir, filename);

    if (bundle) {
      await this.runBundleBackup(fullPath);
    } else {
      await this.runDbDump(fullPath);
    }

    const st = await fs.stat(fullPath);
    await this.setLastRunAt(startedAt);
    await this.applyRetention();
    return {
      filename,
      sizeBytes: st.size,
      durationMs: Date.now() - startedAt.getTime(),
    };
  }

  // Plain pg_dump → custom-format file at the given path. Used by both the
  // legacy single-file flow and as the database.dump step inside the v1.32.3
  // tarball.
  private async runDbDump(filePath: string): Promise<void> {
    const { connectionUrl, schema } = cleanPrismaUrl(this.databaseUrl);
    const args = ['--format=custom', '--no-owner', '--no-acl'];
    if (schema) args.push('--schema', schema);
    args.push('--file', filePath, connectionUrl);
    await runChild('pg_dump', args);
  }

  // v1.32.3: assemble a tarball that round-trips the whole instance —
  // database, attachment blobs, and the .env keys needed to keep encrypted
  // columns + existing sessions valid on the destination host. Each piece
  // is written into a temporary staging directory, then tar -czf bundles
  // it. Staging is cleaned up regardless of success/failure.
  private async runBundleBackup(outPath: string): Promise<void> {
    const staging = await fs.mkdtemp(join(tmpdir(), 'taskhub-backup-'));
    try {
      // 1. database.dump
      await this.runDbDump(join(staging, 'database.dump'));

      // 2. uploads/ — best-effort copy. Missing UPLOAD_DIR means nothing to
      // back up (fresh install / tests); not an error.
      let includedUploads = false;
      if (this.uploadDir) {
        try {
          await fs.access(this.uploadDir);
          await fs.cp(this.uploadDir, join(staging, 'uploads'), { recursive: true });
          includedUploads = true;
        } catch {
          // Directory doesn't exist yet — skip silently.
        }
      }

      // 3. secrets.env — only the keys that affect cross-server restore.
      // POSTGRES_PASSWORD / DATABASE_URL are deliberately NOT included
      // because they're per-host config; including them would invite
      // restoring a backup to clobber the destination's DB connection.
      let includedSecrets = false;
      if (this.hasSecrets()) {
        const lines: string[] = [
          '# TaskHub bundled secrets — written by v1.32.3+ backups.',
          '# Restoring this backup onto another server: copy these into',
          "# the destination's .env and restart the backend. Without",
          '# MASTER_KEY the destination cannot decrypt 2FA secrets or',
          '# LDAP bind passwords; without the JWT secrets every existing',
          '# session is invalidated on first request after restore.',
          '',
        ];
        if (this.secrets?.masterKey) lines.push(`MASTER_KEY=${this.secrets.masterKey}`);
        if (this.secrets?.jwtAccessSecret) lines.push(`JWT_ACCESS_SECRET=${this.secrets.jwtAccessSecret}`);
        if (this.secrets?.jwtRefreshSecret) lines.push(`JWT_REFRESH_SECRET=${this.secrets.jwtRefreshSecret}`);
        await fs.writeFile(join(staging, 'secrets.env'), lines.join('\n') + '\n', { mode: 0o600 });
        includedSecrets = true;
      }

      // 4. manifest.json — small JSON so a restore can introspect what's
      // present without unpacking the whole tarball.
      const manifest = {
        version: 1,
        createdAt: new Date().toISOString(),
        includes: {
          database: true,
          uploads: includedUploads,
          secrets: includedSecrets,
        },
      };
      await fs.writeFile(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2));

      // 5. tar -czf <out> -C <staging> . — bundle everything at the
      // staging root so restore can extract directly into another temp
      // dir and find database.dump etc. at the expected names.
      await runChild('tar', ['-czf', outPath, '-C', staging, '.']);
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
  }

  // v1.28: pg_restore the given dump back into the live database. DESTRUCTIVE:
  // we drop+recreate the public schema before pg_restore so a destination
  // that's already seeded doesn't fight the restore's drops with FK
  // dependencies. The admin must explicitly opt in from the UI confirm
  // dialog; the caller is expected to have already taken a safety dump.
  //
  // v1.32.3: auto-detects format from filename suffix.
  //   - .dump   → legacy pg_restore-direct.
  //   - .tar.gz → extract first, then pg_restore database.dump, then
  //               restore uploads/ into UPLOAD_DIR and write secrets.env
  //               next to the backups as a sidecar the operator applies
  //               by hand (we can't re-read .env from inside the process).
  //
  // The connection is bounced around the restore: Prisma's pool would
  // otherwise hold connections to objects that pg_restore is about to
  // drop, which makes pg_restore wait on lock acquisition.
  // `prisma.$disconnect()` first; Prisma transparently reconnects on the
  // next query.
  async restoreBackup(filename: string): Promise<{
    filename: string;
    durationMs: number;
    secretsApplied: boolean;
    secretsSidecar: string | null;
    uploadsRestored: boolean;
  }> {
    const safe = sanitiseFilename(filename);
    const fullPath = join(this.backupDir, safe);
    try {
      await fs.access(fullPath);
    } catch {
      throw Errors.notFound('Backup not found');
    }

    const isBundle = safe.endsWith(FILE_SUFFIX_BUNDLE);
    const startedAt = Date.now();
    let secretsApplied = false;
    let secretsSidecar: string | null = null;
    let uploadsRestored = false;
    let staging: string | null = null;

    try {
      // Resolve where pg_restore should read its custom-format dump from.
      // Legacy `.dump` files ARE that file; bundled `.tar.gz` files need
      // unpacking first and we read database.dump out of staging.
      let dumpPath = fullPath;
      if (isBundle) {
        staging = await fs.mkdtemp(join(tmpdir(), 'taskhub-restore-'));
        await runChild('tar', ['-xzf', fullPath, '-C', staging]);
        dumpPath = join(staging, 'database.dump');
        try {
          await fs.access(dumpPath);
        } catch {
          throw Errors.badRequest('Backup archive is missing database.dump');
        }
      }

      // v1.32.3: drop+recreate the public schema BEFORE pg_restore. Without
      // this step `pg_restore --clean --if-exists --exit-on-error` fails on
      // any FK dependency the destination already carries (e.g. on a
      // freshly-seeded box, DirectoryGroupMapping_roleId_fkey vs
      // Role_pkey). We disconnect Prisma first so its pool doesn't hold the
      // tables open.
      await prisma.$disconnect();
      await this.wipeSchema();

      const { connectionUrl, schema } = cleanPrismaUrl(this.databaseUrl);
      // v1.30.4 (S-12): --exit-on-error makes pg_restore stop AND exit
      // non-zero on the first SQL error rather than logging and pressing
      // on with a partial restore.
      // We can drop `--clean --if-exists` now that we wipe the schema
      // manually first; keeping `--if-exists` would be a no-op against an
      // empty schema and avoid noisy stderr on objects pg_restore decides
      // to redrop.
      const args = [
        '--no-owner',
        '--no-acl',
        '--exit-on-error',
        '--dbname',
        connectionUrl,
      ];
      if (schema) args.push('--schema', schema);
      args.push(dumpPath);

      const result = await runChildCapture('pg_restore', args);
      if (!result.ok) {
        const msg = result.stderr.length > 0 ? result.stderr : 'unknown error';
        throw Errors.badRequest(
          `pg_restore exited ${result.code ?? 'with spawn error'}: ${msg}`,
        );
      }

      if (isBundle && staging) {
        // Uploads — overwrite UPLOAD_DIR contents with whatever the
        // backup carried. Refuses to act when UPLOAD_DIR wasn't wired in
        // (the operator restores via CLI, not the admin UI); skip
        // silently in that case so the DB-only path still completes.
        const stagedUploads = join(staging, 'uploads');
        if (this.uploadDir) {
          try {
            await fs.access(stagedUploads);
            await fs.mkdir(this.uploadDir, { recursive: true });
            // Wipe + replace. We don't try to merge — the backup is the
            // source of truth for what attachments exist.
            for (const entry of await fs.readdir(this.uploadDir)) {
              await fs.rm(join(this.uploadDir, entry), { recursive: true, force: true });
            }
            await fs.cp(stagedUploads, this.uploadDir, { recursive: true });
            uploadsRestored = true;
          } catch {
            // Bundle didn't carry uploads (or copy failed) — proceed.
          }
        }

        // Secrets sidecar — written next to the backups in BACKUP_DIR. We
        // can't apply these to the running process; the operator copies
        // them into .env and restarts the backend (the restore endpoint
        // already triggers a graceful exit so compose restarts the
        // container, which picks up the new env on boot).
        const stagedSecrets = join(staging, 'secrets.env');
        try {
          await fs.access(stagedSecrets);
          const sidecarPath = join(this.backupDir, RESTORED_SECRETS_FILENAME);
          await fs.copyFile(stagedSecrets, sidecarPath);
          await fs.chmod(sidecarPath, 0o600).catch(() => undefined);
          secretsApplied = true;
          secretsSidecar = RESTORED_SECRETS_FILENAME;
        } catch {
          // Bundle didn't carry secrets — proceed.
        }
      }

      return {
        filename: safe,
        durationMs: Date.now() - startedAt,
        secretsApplied,
        secretsSidecar,
        uploadsRestored,
      };
    } finally {
      if (staging) {
        await fs.rm(staging, { recursive: true, force: true });
      }
    }
  }

  // v1.32.3: drop+recreate the public schema. Used at the start of every
  // restore so the destination DB is a clean target.
  private async wipeSchema(): Promise<void> {
    const { connectionUrl, schema } = cleanPrismaUrl(this.databaseUrl);
    const target = schema || 'public';
    // We can't safely interpolate the schema name into the SQL string at
    // runtime — psql `-c` interprets one statement and quoting rules differ
    // from server-side prepared statements. Whitelist to known-safe shape.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(target)) {
      throw new Error(`Refusing to wipe schema with suspicious name: ${target}`);
    }
    const sql = `DROP SCHEMA IF EXISTS "${target}" CASCADE; CREATE SCHEMA "${target}";`;
    await runChild('psql', ['-v', 'ON_ERROR_STOP=1', '-c', sql, connectionUrl]);
  }

  // v1.28: stream an admin-uploaded .dump into BACKUP_DIR. The caller-supplied
  // filename is sanitised + namespaced so it can never collide with a
  // scheduler-written file (those start with `taskhub-`).
  async saveUpload(args: {
    stream: NodeJS.ReadableStream;
    originalName: string;
    isTruncated: () => boolean;
  }): Promise<BackupFile> {
    await fs.mkdir(this.backupDir, { recursive: true });
    const finalName = uploadedFilename(args.originalName);
    const fullPath = join(this.backupDir, finalName);
    try {
      await pipeline(args.stream, createWriteStream(fullPath));
    } catch (err) {
      await fs.unlink(fullPath).catch(() => undefined);
      throw err;
    }
    if (args.isTruncated()) {
      await fs.unlink(fullPath).catch(() => undefined);
      throw Errors.badRequest('Uploaded file exceeded the size limit');
    }
    const st = await fs.stat(fullPath);
    return {
      filename: finalName,
      sizeBytes: st.size,
      createdAt: st.mtime.toISOString(),
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
    // Retention only applies to scheduler-written dumps. Admin uploads sit
    // outside the rotation — they're explicit acts the admin can delete by
    // hand. Otherwise an uploaded restore-source would vanish on the next
    // tick.
    const files = (await this.list()).filter((f) => f.filename.startsWith(FILE_PREFIX));
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

// v2.5.36: coerce a stored/patched online-backup config into a safe shape.
function normaliseOnlineConfig(input: unknown): OnlineBackupConfig {
  const v = (input ?? {}) as Record<string, unknown>;
  const d = DEFAULT_ONLINE_BACKUP_CONFIG;
  const num = (raw: unknown, def: number, lo: number, hi: number): number => {
    const n = Number(raw);
    return Number.isFinite(n) ? clamp(Math.round(n), lo, hi) : def;
  };
  return {
    enabled: typeof v.enabled === 'boolean' ? v.enabled : d.enabled,
    provider: 'GDRIVE',
    folderId: typeof v.folderId === 'string' ? v.folderId.trim().slice(0, 200) : d.folderId,
    intervalHours: num(v.intervalHours, d.intervalHours, 1, 24 * 30),
    keepDaily: num(v.keepDaily, d.keepDaily, 0, 365),
    keepWeekly: num(v.keepWeekly, d.keepWeekly, 0, 520),
    keepMonthly: num(v.keepMonthly, d.keepMonthly, 0, 240),
  };
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
//
// v1.28: also accept the upload prefix so admin-uploaded dumps round-trip
// through download / restore / delete.
const UPLOAD_PREFIX = 'upload-';

function sanitiseFilename(name: string): string {
  const bare = basename(name);
  if (bare !== name) throw Errors.badRequest('Invalid backup filename');
  const prefixOk = bare.startsWith(FILE_PREFIX) || bare.startsWith(UPLOAD_PREFIX);
  const suffixOk = ACCEPTED_SUFFIXES.some((s) => bare.endsWith(s));
  if (!prefixOk || !suffixOk) throw Errors.badRequest('Invalid backup filename');
  if (bare.includes('/') || bare.includes('\\') || bare.includes('..')) {
    throw Errors.badRequest('Invalid backup filename');
  }
  return bare;
}

// Derive a safe on-disk name from an admin-uploaded dump. We keep the
// original stem (without extension) for human readability, but enforce the
// `upload-{ISO timestamp}-{stem}.dump` shape so listing / download /
// retention all work the same as for scheduler-written files.
function uploadedFilename(original: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = basename(original);
  // v1.32.3: preserve the uploaded extension so a `.tar.gz` upload becomes a
  // .tar.gz on disk and the restore flow's auto-detect picks the right
  // path. .dump uploads from older instances still round-trip.
  const lower = base.toLowerCase();
  const suffix = lower.endsWith(FILE_SUFFIX_BUNDLE)
    ? FILE_SUFFIX_BUNDLE
    : FILE_SUFFIX_LEGACY;
  const stem = base
    .replace(/\.tar\.gz$/i, '')
    .replace(/\.[^.]+$/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .slice(0, 60) || 'dump';
  return `${UPLOAD_PREFIX}${stamp}-${stem}${suffix}`;
}

// v1.32.3: spawn a child process; reject on non-zero exit. Used for
// fire-and-forget invocations where the captured stderr is good enough as
// the error message.
async function runChild(bin: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (b) => {
      stderr += b.toString();
    });
    child.on('error', (err) => {
      reject(new Error(`${bin} failed to start: ${err.message}`));
    });
    child.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`${bin} exited ${code}: ${stderr.trim() || 'unknown error'}`));
    });
  });
}

// Like runChild but resolves with the capture result instead of throwing —
// the caller decides how to surface the failure. pg_restore wants this
// because we tunnel the stderr verbatim into a 400 response so the admin
// can see the actual SQL error.
async function runChildCapture(
  bin: string,
  args: string[],
): Promise<{ ok: true } | { ok: false; code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (b) => {
      stderr += b.toString();
    });
    child.on('error', (err) => {
      resolve({ ok: false, code: null, stderr: `${bin} failed to start: ${err.message}` });
    });
    child.on('close', (code) => {
      if (code === 0) return resolve({ ok: true });
      resolve({ ok: false, code, stderr: stderr.trim() });
    });
  });
}

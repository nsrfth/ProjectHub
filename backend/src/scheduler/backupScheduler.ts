import type { FastifyBaseLogger } from 'fastify';
import type { BackupsService } from '../services/backupsService.js';

// v1.27: backup scheduler. Wakes up every BACKUP_CHECK_INTERVAL_MIN minutes,
// reads the admin-tunable backup.config (enabled + intervalHours), compares
// against backup.lastRunAt, and fires pg_dump when due.
//
// Why two layers (env BACKUP_ENABLED + InstanceSetting enabled):
//   - env flag controls whether this loop runs at ALL in the process (so
//     multi-replica deploys can pin the loop to one node)
//   - InstanceSetting.enabled lets an admin toggle backups on/off from the
//     UI without an env change + redeploy
//
// Both must be true for a tick to write a dump.

export interface BackupSchedulerOptions {
  service: BackupsService;
  intervalMin: number;
  logger: FastifyBaseLogger;
}

export interface BackupScheduler {
  start: () => void;
  stop: () => void;
  runOnce: () => Promise<{ ran: boolean; reason?: string }>;
}

export function createBackupScheduler(opts: BackupSchedulerOptions): BackupScheduler {
  let handle: NodeJS.Timeout | null = null;
  // Re-entrancy guard. runBackup() writes lastRunAt only AFTER pg_dump + the
  // tarball finish; a dump that outlasts the check interval would otherwise let
  // the next tick read the still-old lastRunAt, see it as due, and launch a
  // second concurrent pg_dump (wasteful, and IO contention). One dump at a time.
  let running = false;

  async function tick(): Promise<{ ran: boolean; reason?: string }> {
    if (running) return { ran: false, reason: 'a backup is already running' };
    running = true;
    try {
      const cfg = await opts.service.getConfig();
      if (!cfg.enabled) return { ran: false, reason: 'disabled in settings' };

      const last = await opts.service.getLastRunAt();
      const dueAt = last ? new Date(last.getTime() + cfg.intervalHours * 3600_000) : new Date(0);
      const now = new Date();
      if (now < dueAt) {
        return { ran: false, reason: `next due ${dueAt.toISOString()}` };
      }

      const result = await opts.service.runBackup();
      opts.logger.info(
        { filename: result.filename, sizeBytes: result.sizeBytes, durationMs: result.durationMs },
        'backup written',
      );
      return { ran: true };
    } catch (err) {
      opts.logger.error({ err }, 'backup tick failed');
      return { ran: false, reason: (err as Error).message };
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (handle) return;
      const ms = opts.intervalMin * 60 * 1000;
      // Don't run immediately on boot — the lastRunAt comparison handles
      // catching up a missed window without us forcing it, and a boot-time
      // pg_dump can fight with prisma migrate deploy.
      handle = setInterval(() => {
        tick().catch((err) => opts.logger.error({ err }, 'backup tick failed'));
      }, ms);
      opts.logger.info({ intervalMin: opts.intervalMin }, 'backup scheduler started');
    },
    stop() {
      if (handle) {
        clearInterval(handle);
        handle = null;
      }
    },
    runOnce: tick,
  };
}

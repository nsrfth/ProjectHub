import type { FastifyBaseLogger } from 'fastify';
import type {
  DirectorySyncRunOptions,
  DirectorySyncService,
  DirectorySyncSummary,
} from '../services/directorySyncService.js';

// v2.6 (Phase 0a): scheduled directory sync loop.
//
// Two layers of gating, matching the backup scheduler's shape:
//   - env DIRECTORY_SYNC_ENABLED controls whether this loop runs AT ALL in
//     this process, so multi-replica deploys pin it to one node
//   - Directory.syncEnabled lets an admin opt a single directory in or out
//     from Settings → Directories without an env change + redeploy
//
// Both must be true for a directory to be walked.
//
// Enable on exactly one node. The overlap guard below is per-process and
// provides no cross-replica mutual exclusion.

export interface DirectorySyncSchedulerOptions {
  service: DirectorySyncService;
  intervalMin: number;
  run: Omit<DirectorySyncRunOptions, 'dryRun'> & { dryRun: boolean };
  logger: FastifyBaseLogger;
}

export interface DirectorySyncScheduler {
  start: () => void;
  stop: () => void;
  /** Optional overrides for deterministic tests and the admin "run now" path. */
  runOnce: (override?: Partial<DirectorySyncRunOptions>) => Promise<DirectorySyncSummary | null>;
}

export function createDirectorySyncScheduler(
  opts: DirectorySyncSchedulerOptions,
): DirectorySyncScheduler {
  let handle: NodeJS.Timeout | null = null;

  // Re-entrancy guard. NEW FOR THIS CODEBASE — the other schedulers rely on
  // idempotence and DB markers instead, which is fine for their minute-scale
  // ticks. A full directory walk against a slow or unreachable domain
  // controller can plausibly outrun even a daily interval, and two concurrent
  // runs would race on the same memberships.
  let running = false;

  async function tick(
    override?: Partial<DirectorySyncRunOptions>,
  ): Promise<DirectorySyncSummary | null> {
    if (running) {
      opts.logger.warn({}, 'directory sync skipped — previous run still in progress');
      return null;
    }
    running = true;
    try {
      const summary = await opts.service.run({ ...opts.run, ...override });

      const conflicts = summary.directories.reduce((n, d) => n + d.conflicts.length, 0);
      const aborted = summary.directories.filter((d) => d.status === 'ABORTED');
      const fields = {
        runId: summary.runId,
        dryRun: summary.dryRun,
        directories: summary.directories.length,
        usersMatched: summary.directories.reduce((n, d) => n + d.usersMatched, 0),
        usersUnmatched: summary.directories.reduce((n, d) => n + d.usersUnmatched, 0),
        membershipsAdded: summary.directories.reduce((n, d) => n + d.membershipsAdded, 0),
        membershipsRemoved: summary.directories.reduce((n, d) => n + d.membershipsRemoved, 0),
        conflicts,
      };

      // Quiet when there is nothing to say, loud when there is — the other
      // schedulers set this convention and idle logs stay clean because of it.
      if (aborted.length > 0) {
        opts.logger.error(
          { ...fields, aborted: aborted.map((d) => ({ slug: d.directorySlug, reason: d.abortReason })) },
          'directory sync aborted for one or more directories',
        );
      } else if (conflicts > 0) {
        opts.logger.warn(fields, 'directory sync completed with conflicts');
      } else if (summary.directories.length > 0) {
        opts.logger.info(fields, 'directory sync completed');
      }

      return summary;
    } catch (err) {
      opts.logger.error({ err }, 'directory sync tick failed');
      return null;
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (handle) return;
      const ms = opts.intervalMin * 60 * 1000;
      // Don't walk the directory on boot — it would contend with
      // `prisma migrate deploy` during a deploy, and the job has no catch-up
      // semantics that a delayed first run would miss.
      handle = setInterval(() => {
        tick().catch((err) => opts.logger.error({ err }, 'directory sync tick failed'));
      }, ms);
      opts.logger.info(
        { intervalMin: opts.intervalMin, dryRun: opts.run.dryRun },
        'directory sync scheduler started',
      );
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

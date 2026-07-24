import type { FastifyBaseLogger } from 'fastify';
import { AssignmentRequestsService } from '../services/assignmentRequestsService.js';

// v-next (P3): SLA lifecycle for cross-unit assignment requests. In-process
// setInterval like the other schedulers (fine for the single-replica Docker
// Compose default). Two jobs per tick: expire lapsed pending requests
// (→ EXPIRED, requester notified) and fire the one-shot T-1 reminder to
// approvers. Lives in server.ts only — buildApp never starts it, so tests do
// not fire background timers; runOnce() is the deterministic test seam.

export interface AssignmentSlaSchedulerOptions {
  intervalMin: number;
  reminderLeadHours: number;
  logger: FastifyBaseLogger;
}

export interface AssignmentSlaScheduler {
  start: () => void;
  stop: () => void;
  /** Optional `at` for deterministic tests. Returns expired + reminded. */
  runOnce: (at?: Date) => Promise<number>;
}

export function createAssignmentSlaScheduler(
  opts: AssignmentSlaSchedulerOptions,
): AssignmentSlaScheduler {
  const svc = new AssignmentRequestsService();
  let handle: NodeJS.Timeout | null = null;

  async function tick(at?: Date): Promise<number> {
    const expired = await svc.sweepExpired(at);
    const reminded = await svc.remindSoon(opts.reminderLeadHours * 3_600_000, at);
    if (expired > 0) opts.logger.info({ count: expired }, 'assignment requests expired');
    if (reminded > 0) opts.logger.info({ count: reminded }, 'assignment SLA reminders emitted');
    return expired + reminded;
  }

  return {
    start() {
      if (handle) return;
      const ms = opts.intervalMin * 60 * 1000;
      // Re-entrancy guard, same rationale as the due-date scheduler: a slow tick
      // must not overlap the next and double-process rows.
      let running = false;
      const guardedTick = async (): Promise<void> => {
        if (running) return;
        running = true;
        try {
          await tick();
        } catch (err) {
          opts.logger.error({ err }, 'assignment SLA tick failed');
        } finally {
          running = false;
        }
      };
      void guardedTick();
      handle = setInterval(() => void guardedTick(), ms);
      opts.logger.info({ intervalMin: opts.intervalMin }, 'assignment SLA scheduler started');
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

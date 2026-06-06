import type { FastifyBaseLogger } from 'fastify';
import { TaskTemplatesService } from '../services/taskTemplatesService.js';

// Recurrence scheduler — periodically asks TaskTemplatesService to spawn
// any due tasks. Modelled on dueDateScheduler so all three background
// loops (TASK_DUE, webhooks, recurrence) share the factory shape.
//
// Multi-instance deploys must enable this on exactly one node to avoid
// double-spawning. The TaskTemplatesService transaction does protect via
// the (templateId, spawnedForPeriod) unique constraint, but throwing on
// every duplicate insert across N nodes is wasteful — single-node is the
// supported configuration.

interface SchedulerOptions {
  intervalMin: number;
  logger: FastifyBaseLogger;
}

export interface RecurrenceScheduler {
  start(): void;
  stop(): void;
  tick(): Promise<number>;
}

export function createRecurrenceScheduler(opts: SchedulerOptions): RecurrenceScheduler {
  const svc = new TaskTemplatesService();
  let timer: NodeJS.Timeout | null = null;

  async function tick(): Promise<number> {
    try {
      const spawned = await svc.spawnDue(new Date());
      if (spawned > 0) {
        opts.logger.info({ spawned }, 'recurrence tick spawned tasks');
      }
      return spawned;
    } catch (err) {
      opts.logger.error({ err }, 'recurrence tick failed');
      return 0;
    }
  }

  return {
    start() {
      if (timer) return;
      void tick();
      timer = setInterval(() => void tick(), opts.intervalMin * 60_000);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick,
  };
}

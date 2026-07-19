import type { FastifyBaseLogger } from 'fastify';
import { WebhookService } from '../services/webhookService.js';

// Webhook dispatcher — polls the WebhookDelivery table on an interval and
// drives the queue. Modelled after dueDateScheduler so both background
// loops share the same shape (factory → start/stop, opt-in via env).
//
// Multi-instance deploys MUST NOT enable this on more than one node: each
// poll picks up the same PENDING rows and would deliver them N times. The
// proper fix is row-level locking (SELECT … FOR UPDATE SKIP LOCKED), out of
// scope for Phase 3B.

interface DispatcherOptions {
  intervalSec: number;
  batch: number;
  logger: FastifyBaseLogger;
}

export interface WebhookDispatcher {
  start(): void;
  stop(): void;
  tick(): Promise<number>;
}

export function createWebhookDispatcher(opts: DispatcherOptions): WebhookDispatcher {
  const svc = new WebhookService();
  let timer: NodeJS.Timeout | null = null;
  // In-process re-entrancy guard. drainOnce reads status=PENDING rows and only
  // flips each to DELIVERED/PENDING after its own POST resolves (up to ~10s
  // each). At the default 5s interval a tick blocked on a slow endpoint would
  // otherwise let the next tick re-select the same still-PENDING rows and
  // deliver them twice. This does NOT provide cross-process mutual exclusion —
  // multi-instance deploys must still enable the dispatcher on exactly one node.
  let running = false;

  async function tick(): Promise<number> {
    if (running) return 0;
    running = true;
    try {
      const processed = await svc.drainOnce(opts.batch);
      if (processed > 0) {
        opts.logger.debug({ processed }, 'webhook dispatch tick');
      }
      return processed;
    } catch (err) {
      opts.logger.error({ err }, 'webhook dispatch tick failed');
      return 0;
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer) return;
      // Kick once on start so a freshly-booted instance doesn't wait the
      // full interval before draining anything queued during downtime.
      void tick();
      timer = setInterval(() => void tick(), opts.intervalSec * 1000);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick,
  };
}

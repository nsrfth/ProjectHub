import type { FastifyInstance } from 'fastify';

// v1.30.4 (S-5): a registry the server boot uses to plug scheduler
// stoppers + a process.exit hook into the Fastify instance so the
// backup-restore route can orchestrate a clean drain without growing
// circular imports.
//
// `stopBackground()` is called by the restore flow to stop every
// in-process scheduler (TASK_DUE, WEBHOOK, RECURRENCE, BACKUP) before
// pg_restore runs — otherwise a scheduler tick mid-restore would race
// the table drops.
//
// `processExit(code)` is called LAST. In production it terminates the
// node process so docker compose's `restart: unless-stopped` brings up
// a fresh container that picks up the restored schema. In tests it's
// swapped for a no-op so the test runner doesn't exit.

export interface AppLifecycle {
  stopBackground: () => void;
  processExit: (code: number) => void;
}

declare module 'fastify' {
  interface FastifyInstance {
    lifecycle: AppLifecycle;
  }
}

export function decorateLifecycle(app: FastifyInstance, lifecycle: AppLifecycle): void {
  app.decorate('lifecycle', lifecycle);
}

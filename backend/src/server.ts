import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';
import { createDueDateScheduler } from './scheduler/dueDateScheduler.js';
import { createWebhookDispatcher } from './scheduler/webhookDispatcher.js';
import { createRecurrenceScheduler } from './scheduler/recurrenceScheduler.js';
import { createAssignmentSlaScheduler } from './scheduler/assignmentSlaScheduler.js';
import { createBackupScheduler } from './scheduler/backupScheduler.js';
import { createDirectorySyncScheduler } from './scheduler/directorySyncScheduler.js';
import { BackupsService } from './services/backupsService.js';
import { DirectorySyncService } from './services/directorySyncService.js';
import { LdapService } from './services/ldapService.js';
import { clearMaintenance } from './lib/maintenance.js';
import { bootstrapSystemManagerOnAllTeams, bootstrapSystemUserFlag } from './lib/systemUser.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const app = await buildApp(env);

  // Background scheduler — opt-in via env. Lives only in server.ts (not
  // buildApp) so test runs don't accidentally fire background timers.
  const dueScheduler = env.TASK_DUE_ENABLED
    ? createDueDateScheduler({
        defaultLeadHours: env.TASK_DUE_LEAD_HOURS,
        intervalMin: env.TASK_DUE_CHECK_INTERVAL_MIN,
        logger: app.log,
      })
    : null;
  dueScheduler?.start();

  // Webhook delivery loop. Same opt-in shape; default off so tests don't
  // fire outbound HTTP.
  const webhookDispatcher = env.WEBHOOK_DISPATCH_ENABLED
    ? createWebhookDispatcher({
        intervalSec: env.WEBHOOK_DISPATCH_INTERVAL_SEC,
        batch: env.WEBHOOK_DISPATCH_BATCH,
        logger: app.log,
      })
    : null;
  webhookDispatcher?.start();

  // Recurrence — spawns repeating tasks when their nextRunAt elapses.
  const recurrenceScheduler = env.RECURRENCE_ENABLED
    ? createRecurrenceScheduler({
        intervalMin: env.RECURRENCE_CHECK_INTERVAL_MIN,
        logger: app.log,
      })
    : null;
  recurrenceScheduler?.start();

  // v-next (P3): assignment-request SLA sweep + reminder. Opt-in; default off
  // so tests and multi-instance deploys don't double-fire.
  const assignmentSlaScheduler = env.ASSIGNMENT_SLA_ENABLED
    ? createAssignmentSlaScheduler({
        intervalMin: env.ASSIGNMENT_SLA_CHECK_INTERVAL_MIN,
        reminderLeadHours: env.ASSIGNMENT_SLA_REMINDER_LEAD_HOURS,
        logger: app.log,
      })
    : null;
  assignmentSlaScheduler?.start();

  // Automatic Postgres backups (v1.27). Same opt-in shape; the admin can
  // also disable backups in Settings → Backups without an env change.
  const backupScheduler = env.BACKUP_ENABLED
    ? createBackupScheduler({
        // v1.32.3: scheduled backups also bundle uploads + secrets so the
        // nightly dump is a full restore-anywhere artefact.
        service: new BackupsService(env.DATABASE_URL, env.BACKUP_DIR, {
          uploadDir: env.UPLOAD_DIR,
          secrets: {
            masterKey: env.MASTER_KEY ?? null,
            jwtAccessSecret: env.JWT_ACCESS_SECRET ?? null,
            jwtRefreshSecret: env.JWT_REFRESH_SECRET ?? null,
          },
        }),
        intervalMin: env.BACKUP_CHECK_INTERVAL_MIN,
        logger: app.log,
      })
    : null;
  backupScheduler?.start();

  // v2.6 (Phase 0a): scheduled directory sync. Same opt-in shape; a directory
  // must ALSO have syncEnabled set in Settings → Directories. Enable the env
  // flag on exactly one node — the overlap guard is per-process.
  const directorySyncScheduler = env.DIRECTORY_SYNC_ENABLED
    ? createDirectorySyncScheduler({
        service: new DirectorySyncService(new LdapService(), app.log),
        intervalMin: env.DIRECTORY_SYNC_INTERVAL_MIN,
        run: {
          pageSize: env.DIRECTORY_SYNC_PAGE_SIZE,
          maxUsers: env.DIRECTORY_SYNC_MAX_USERS,
          timeoutSec: env.DIRECTORY_SYNC_TIMEOUT_SEC,
          revokeGlobalRole: env.DIRECTORY_SYNC_REVOKE_GLOBAL_ROLE,
          dryRun: env.DIRECTORY_SYNC_DRY_RUN,
        },
        logger: app.log,
      })
    : null;
  directorySyncScheduler?.start();

  // v1.30.4 (S-5): plug real scheduler-stoppers + process.exit into the
  // app lifecycle so the backup-restore route can drain cleanly. Defaults
  // installed inside buildApp are no-ops — fine for tests, replaced here
  // for the real boot.
  app.lifecycle.stopBackground = () => {
    dueScheduler?.stop();
    webhookDispatcher?.stop();
    recurrenceScheduler?.stop();
    backupScheduler?.stop();
    directorySyncScheduler?.stop();
    assignmentSlaScheduler?.stop();
  };
  app.lifecycle.processExit = (code) => process.exit(code);

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    try {
      dueScheduler?.stop();
      webhookDispatcher?.stop();
      recurrenceScheduler?.stop();
      backupScheduler?.stop();
      directorySyncScheduler?.stop();
    assignmentSlaScheduler?.stop();
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'shutdown failed');
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await bootstrapSystemUserFlag();
    const backfill = await bootstrapSystemManagerOnAllTeams();
    if (backfill.created > 0) {
      app.log.info(backfill, 'system manager backfill on existing teams');
    }
    await app.listen({ host: process.env.HOST ?? '0.0.0.0', port: env.PORT });
    // v1.30.4 (S-5): once the listener is up, clear any persisted
    // maintenance flag. This is what makes the restore flow's
    // process.exit safe — the fresh boot lifts the 503 gate. We do it
    // POST-listen so a backend that crashed mid-boot doesn't
    // accidentally lift the gate before it can serve real traffic.
    await clearMaintenance();
    app.log.info('maintenance mode cleared (post-boot)');
  } catch (err) {
    app.log.error({ err }, 'failed to start');
    process.exit(1);
  }
}

void main();

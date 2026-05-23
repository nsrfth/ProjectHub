import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';
import { createDueDateScheduler } from './scheduler/dueDateScheduler.js';
import { createWebhookDispatcher } from './scheduler/webhookDispatcher.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const app = await buildApp(env);

  // Background scheduler — opt-in via env. Lives only in server.ts (not
  // buildApp) so test runs don't accidentally fire background timers.
  const dueScheduler = env.TASK_DUE_ENABLED
    ? createDueDateScheduler({
        leadHours: env.TASK_DUE_LEAD_HOURS,
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

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    try {
      dueScheduler?.stop();
      webhookDispatcher?.stop();
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
    await app.listen({ host: '0.0.0.0', port: env.PORT });
  } catch (err) {
    app.log.error({ err }, 'failed to start');
    process.exit(1);
  }
}

void main();

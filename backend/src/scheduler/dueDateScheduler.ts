import { prisma } from '../data/prisma.js';
import { notifications } from '../services/notificationsService.js';
import type { FastifyBaseLogger } from 'fastify';

// Scheduler for TASK_DUE notifications. Runs in-process via setInterval —
// fine for single-replica deployments (the default Docker Compose setup).
// For multi-replica or production-grade durability, swap this for BullMQ on
// the existing Redis container.
//
// One-shot per (taskId, dueDate): Task.dueNotifiedAt holds the timestamp of
// the last emission and is reset to null whenever dueDate is changed (see
// tasksService.update). So the scheduler only emits when:
//   - dueDate is non-null AND in the future AND within the lead window
//   - dueNotifiedAt is null
// then it stamps dueNotifiedAt = now so the next tick is a no-op.

export interface DueSchedulerOptions {
  leadHours: number;
  intervalMin: number;
  logger: FastifyBaseLogger;
}

export interface DueScheduler {
  start: () => void;
  stop: () => void;
  // Exposed for tests + smoke runs — same logic as a scheduler tick.
  runOnce: () => Promise<number>;
}

export function createDueDateScheduler(opts: DueSchedulerOptions): DueScheduler {
  let handle: NodeJS.Timeout | null = null;

  async function tick(): Promise<number> {
    const now = new Date();
    const cutoff = new Date(now.getTime() + opts.leadHours * 60 * 60 * 1000);
    // 30-day floor to avoid spamming reminders for ancient overdue tasks that
    // get unearthed by a backfill or schema fix. Anything older than this
    // probably needs a human to triage rather than a notification.
    const floor = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Tasks due any time up to the cutoff (including already-overdue) that
    // are still OPEN and haven't been notified yet. The old (now, cutoff]
    // window silently skipped overdue tasks — bug fix.
    const dueTasks = await prisma.task.findMany({
      where: {
        dueNotifiedAt: null,
        status: { in: ['TODO', 'IN_PROGRESS', 'REVIEW'] },
        dueDate: { gte: floor, lte: cutoff },
      },
      select: { id: true, title: true, dueDate: true, projectId: true, teamId: true },
    });

    if (dueTasks.length === 0) return 0;

    let emitted = 0;
    for (const t of dueTasks) {
      try {
        // Emit + stamp in one transaction so a successful emit always pairs
        // with a stamp (eliminates the "notified but DB roll back" risk).
        await prisma.$transaction(async (tx) => {
          await notifications.onTaskDue(tx, {
            taskId: t.id,
            projectId: t.projectId,
            teamId: t.teamId,
            taskTitle: t.title,
            dueDate: t.dueDate!.toISOString(),
          });
          await tx.task.update({
            where: { id: t.id },
            data: { dueNotifiedAt: now },
          });
        });
        emitted += 1;
      } catch (err) {
        opts.logger.error({ err, taskId: t.id }, 'TASK_DUE emit failed');
      }
    }
    if (emitted > 0) {
      opts.logger.info({ count: emitted, leadHours: opts.leadHours }, 'TASK_DUE notifications emitted');
    }
    return emitted;
  }

  return {
    start() {
      if (handle) return;
      const ms = opts.intervalMin * 60 * 1000;
      // Run immediately so newly-due tasks aren't held until the first interval.
      tick().catch((err) => opts.logger.error({ err }, 'TASK_DUE tick failed'));
      handle = setInterval(() => {
        tick().catch((err) => opts.logger.error({ err }, 'TASK_DUE tick failed'));
      }, ms);
      opts.logger.info(
        { intervalMin: opts.intervalMin, leadHours: opts.leadHours },
        'TASK_DUE scheduler started',
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

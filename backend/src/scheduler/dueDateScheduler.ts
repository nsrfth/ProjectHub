import { prisma } from '../data/prisma.js';
import { notifications } from '../services/notificationsService.js';
import { emailService } from '../services/emailService.js';
import { mailer } from '../lib/mailer.js';
import type { FastifyBaseLogger } from 'fastify';
import { WorkingDayCalendar } from '../lib/workingDays.js';
import {
  DEFAULT_REMINDER_LEAD_HOURS,
  readReminderSettings,
  resolveLeadHours,
  shouldEmitDueReminder,
} from '../lib/reminderTiming.js';

// Scheduler for TASK_DUE notifications. Runs in-process via setInterval —
// fine for single-replica deployments (the default Docker Compose setup).
//
// One-shot per (taskId, dueDate): Task.dueNotifiedAt holds the timestamp of
// the last emission and is reset to null whenever dueDate is changed (see
// tasksService.update).
//
// v1.65: per-user reminderLeadHours (assignee, else creator) replaces the
// fixed env lead window. Optional reminders.skipOffDays shifts the notify
// instant to the prior working day when it would fall on a weekend/holiday.

export interface DueSchedulerOptions {
  /** Fallback lead when user.reminderLeadHours is unset. */
  defaultLeadHours: number;
  intervalMin: number;
  logger: FastifyBaseLogger;
}

export interface DueScheduler {
  start: () => void;
  stop: () => void;
  /** Optional `at` for deterministic tests. */
  runOnce: (at?: Date) => Promise<number>;
}

export function createDueDateScheduler(opts: DueSchedulerOptions): DueScheduler {
  let handle: NodeJS.Timeout | null = null;

  async function tick(at?: Date): Promise<number> {
    const now = at ?? new Date();
    const floor = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const reminderSettings = await readReminderSettings();
    const cal = reminderSettings.skipOffDays ? await WorkingDayCalendar.load() : null;

    const maxLeadMs = Math.max(opts.defaultLeadHours, DEFAULT_REMINDER_LEAD_HOURS, 168) * 3_600_000;
    const upperDue = new Date(now.getTime() + Math.max(maxLeadMs, 14 * 24 * 3_600_000));

    const candidates = await prisma.task.findMany({
      where: {
        dueNotifiedAt: null,
        status: { in: ['TODO', 'IN_PROGRESS', 'REVIEW'] },
        dueDate: { not: null, gte: floor, lte: upperDue },
      },
      select: {
        id: true,
        title: true,
        dueDate: true,
        projectId: true,
        teamId: true,
        assignee: { select: { reminderLeadHours: true } },
        creator: { select: { reminderLeadHours: true } },
      },
    });

    const dueTasks = candidates.filter((t) => {
      if (!t.dueDate) return false;
      const leadHours = resolveLeadHours(
        t.assignee?.reminderLeadHours,
        t.creator?.reminderLeadHours,
        opts.defaultLeadHours,
      );
      return shouldEmitDueReminder(
        now,
        t.dueDate,
        leadHours,
        reminderSettings.skipOffDays,
        cal,
        floor,
      );
    });

    let emitted = 0;
    for (const t of dueTasks) {
      try {
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
        if (mailer.isEnabled()) {
          const recipients = await prisma.task
            .findUnique({
              where: { id: t.id },
              select: {
                assignee: { select: { email: true } },
                creator: { select: { email: true } },
              },
            })
            .then((row) => {
              const emails = [row?.assignee?.email, row?.creator?.email].filter(
                (e): e is string => !!e,
              );
              return [...new Set(emails)];
            });
          for (const to of recipients) {
            void emailService.sendTaskDue({
              to,
              taskTitle: t.title,
              projectId: t.projectId,
              taskId: t.id,
              dueDate: t.dueDate!,
            });
          }
        }
        emitted += 1;
      } catch (err) {
        opts.logger.error({ err, taskId: t.id }, 'TASK_DUE emit failed');
      }
    }
    if (emitted > 0) {
      opts.logger.info({ count: emitted }, 'TASK_DUE notifications emitted');
    }

    // v2.5.28: parallel branch for personal (standalone) tasks. Same one-shot
    // marker (lastDueNotifiedAt) + per-owner lead-hours + off-day handling.
    const standaloneEmitted = await tickStandalone(now, floor, upperDue, reminderSettings, cal);

    return emitted + standaloneEmitted;
  }

  async function tickStandalone(
    now: Date,
    floor: Date,
    upperDue: Date,
    reminderSettings: Awaited<ReturnType<typeof readReminderSettings>>,
    cal: WorkingDayCalendar | null,
  ): Promise<number> {
    const candidates = await prisma.standaloneTask.findMany({
      where: {
        lastDueNotifiedAt: null,
        deletedAt: null,
        status: { in: ['TODO', 'IN_PROGRESS'] },
        dueDate: { not: null, gte: floor, lte: upperDue },
      },
      select: {
        id: true,
        title: true,
        dueDate: true,
        ownerId: true,
        owner: { select: { reminderLeadHours: true, email: true } },
      },
    });

    const due = candidates.filter((t) => {
      if (!t.dueDate) return false;
      const leadHours = resolveLeadHours(
        t.owner?.reminderLeadHours,
        undefined,
        opts.defaultLeadHours,
      );
      return shouldEmitDueReminder(
        now,
        t.dueDate,
        leadHours,
        reminderSettings.skipOffDays,
        cal,
        floor,
      );
    });

    let emitted = 0;
    for (const t of due) {
      try {
        await prisma.$transaction(async (tx) => {
          await notifications.onStandaloneTaskDue(tx, {
            standaloneTaskId: t.id,
            ownerId: t.ownerId,
            title: t.title,
            dueDate: t.dueDate!.toISOString(),
          });
          await tx.standaloneTask.update({
            where: { id: t.id },
            data: { lastDueNotifiedAt: now },
          });
        });
        if (mailer.isEnabled() && t.owner?.email) {
          void emailService.sendStandaloneTaskDue({
            to: t.owner.email,
            taskTitle: t.title,
            dueDate: t.dueDate!,
          });
        }
        emitted += 1;
      } catch (err) {
        opts.logger.error({ err, standaloneTaskId: t.id }, 'STANDALONE_TASK_DUE emit failed');
      }
    }
    if (emitted > 0) {
      opts.logger.info({ count: emitted }, 'STANDALONE_TASK_DUE notifications emitted');
    }
    return emitted;
  }

  return {
    start() {
      if (handle) return;
      const ms = opts.intervalMin * 60 * 1000;
      // Re-entrancy guard: a tick selects rows on `dueNotifiedAt: null` and only
      // marks them notified after per-task transactions + emails. If a tick
      // outlasts the interval, an overlapping tick would re-select the same
      // still-null rows and fire the notification (and email) twice. Serialize
      // scheduled ticks; `runOnce` stays direct for deterministic tests.
      let running = false;
      const guardedTick = async () => {
        if (running) return;
        running = true;
        try {
          await tick();
        } catch (err) {
          opts.logger.error({ err }, 'TASK_DUE tick failed');
        } finally {
          running = false;
        }
      };
      void guardedTick();
      handle = setInterval(() => void guardedTick(), ms);
      opts.logger.info(
        { intervalMin: opts.intervalMin, defaultLeadHours: opts.defaultLeadHours },
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

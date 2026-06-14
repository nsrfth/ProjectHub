import { prisma } from '../data/prisma.js';
import { normalizeUtcMidnight } from '../services/holidaysService.js';
import { logActivity } from '../services/activityLogger.js';
import type { Prisma } from '@prisma/client';
import { WorkingDayCalendar } from './workingDays.js';

export interface SchedulingSettings {
  rollOffdayDueDates: boolean;
  workingDaysOnly: boolean;
}

export async function readSchedulingSettings(): Promise<SchedulingSettings> {
  const [rollRow, workRow] = await Promise.all([
    prisma.instanceSetting.findUnique({ where: { key: 'scheduling.rollOffdayDueDates' } }),
    prisma.instanceSetting.findUnique({ where: { key: 'scheduling.workingDaysOnly' } }),
  ]);
  return {
    rollOffdayDueDates: rollRow?.value === true,
    workingDaysOnly: workRow?.value === true,
  };
}

export interface DueDateRollResult {
  dueDate: Date | null;
  /** Set when the date was rolled forward from an off-day. */
  rolled: { from: string; to: string } | null;
}

/**
 * Normalize + optionally roll a due date forward when scheduling.rollOffdayDueDates
 * is enabled. Does NOT mutate existing tasks unless called on create/update/spawn.
 */
export async function resolveDueDateForScheduling(
  dueDate: Date | string | null | undefined,
): Promise<DueDateRollResult> {
  if (dueDate === null || dueDate === undefined) {
    return { dueDate: null, rolled: null };
  }
  const normalized = normalizeUtcMidnight(dueDate);
  const settings = await readSchedulingSettings();
  if (!settings.rollOffdayDueDates) {
    return { dueDate: normalized, rolled: null };
  }
  const cal = await WorkingDayCalendar.load();
  if (!cal.isOffDay(normalized)) {
    return { dueDate: normalized, rolled: null };
  }
  const rolledTo = cal.nextWorkingDay(normalized);
  return {
    dueDate: rolledTo,
    rolled: { from: normalized.toISOString(), to: rolledTo.toISOString() },
  };
}

export async function logDueDateRoll(
  client: Prisma.TransactionClient,
  input: {
    taskId: string;
    actorId: string | null;
    teamId: string;
    rolled: { from: string; to: string };
  },
): Promise<void> {
  await logActivity(client, {
    taskId: input.taskId,
    teamId: input.teamId,
    actorId: input.actorId,
    action: 'task.dueDate_rolled_offday',
    meta: {
      field: 'dueDate',
      from: input.rolled.from,
      to: input.rolled.to,
      reason: 'off_day',
    },
  });
}

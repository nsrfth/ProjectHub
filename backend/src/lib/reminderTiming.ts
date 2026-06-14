import { prisma } from '../data/prisma.js';
import { normalizeUtcMidnight } from '../services/holidaysService.js';
import type { WorkingDayCalendar } from './workingDays.js';

export const DEFAULT_REMINDER_LEAD_HOURS = 24;

export interface ReminderSettings {
  skipOffDays: boolean;
}

export async function readReminderSettings(): Promise<ReminderSettings> {
  try {
    const row = await prisma.instanceSetting.findUnique({
      where: { key: 'reminders.skipOffDays' },
    });
    return { skipOffDays: row?.value === true };
  } catch {
    return { skipOffDays: false };
  }
}

export function resolveLeadHours(
  assigneeLead: number | null | undefined,
  creatorLead: number | null | undefined,
  fallbackHours: number,
): number {
  const pick = assigneeLead ?? creatorLead ?? fallbackHours;
  return pick > 0 ? pick : fallbackHours;
}

/**
 * When skipOffDays is on and the nominal notify instant falls on an off-day
 * (UTC calendar day), shift to the same time-of-day on the prior working day.
 * If that moment is already in the past at tick time, the caller fires immediately.
 */
export function computeEffectiveNotifyAt(
  dueDate: Date,
  leadHours: number,
  skipOffDays: boolean,
  cal: WorkingDayCalendar | null,
): Date {
  const notifyAt = new Date(dueDate.getTime() - leadHours * 3_600_000);
  if (!skipOffDays || !cal) return notifyAt;

  const notifyDay = normalizeUtcMidnight(notifyAt);
  if (!cal.isOffDay(notifyDay)) return notifyAt;

  const shiftedDay = cal.previousWorkingDay(notifyDay);
  const timeOfDayMs = notifyAt.getTime() - notifyDay.getTime();
  return new Date(shiftedDay.getTime() + timeOfDayMs);
}

/** True when the task is eligible for a one-shot TASK_DUE emit at `now`. */
export function shouldEmitDueReminder(
  now: Date,
  dueDate: Date,
  leadHours: number,
  skipOffDays: boolean,
  cal: WorkingDayCalendar | null,
  floor: Date,
): boolean {
  if (dueDate.getTime() < floor.getTime()) return false;
  const notifyAt = computeEffectiveNotifyAt(dueDate, leadHours, skipOffDays, cal);
  return now.getTime() >= notifyAt.getTime();
}

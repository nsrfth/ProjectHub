import { prisma } from '../data/prisma.js';
import { normalizeUtcMidnight } from '../services/holidaysService.js';

/** UTC calendar day + n (preserves UTC-midnight anchor). */
export function addCalendarDays(d: Date, n: number): Date {
  const c = normalizeUtcMidnight(d);
  return new Date(Date.UTC(c.getUTCFullYear(), c.getUTCMonth(), c.getUTCDate() + n));
}

export interface HolidayAnchor {
  date: Date;
  recurring: boolean;
}

/**
 * Server-side mirror of frontend isOffDay — weekends from calendar.weekend
 * InstanceSetting + Holiday rows (exact + recurring month/day).
 */
export class WorkingDayCalendar {
  constructor(
    private readonly weekendDays: number[],
    private readonly holidays: HolidayAnchor[],
  ) {}

  static async load(): Promise<WorkingDayCalendar> {
    let weekendDays: number[] = [0, 6];
    try {
      const row = await prisma.instanceSetting.findUnique({
        where: { key: 'calendar.weekend' },
      });
      const v = row?.value as unknown;
      if (Array.isArray(v)) {
        const cleaned = v
          .map((n) => Number(n))
          .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
        weekendDays = [...new Set(cleaned)].sort((a, b) => a - b);
      }
    } catch {
      // default
    }

    const rows = await prisma.holiday.findMany({
      select: { date: true, recurring: true },
    });
    return new WorkingDayCalendar(
      weekendDays,
      rows.map((r) => ({ date: normalizeUtcMidnight(r.date), recurring: r.recurring })),
    );
  }

  isWeekend(d: Date): boolean {
    return this.weekendDays.includes(normalizeUtcMidnight(d).getUTCDay());
  }

  isHoliday(d: Date): boolean {
    const c = normalizeUtcMidnight(d);
    const y = c.getUTCFullYear();
    const m = c.getUTCMonth();
    const day = c.getUTCDate();
    for (const h of this.holidays) {
      const hd = h.date;
      if (hd.getUTCFullYear() === y && hd.getUTCMonth() === m && hd.getUTCDate() === day) {
        return true;
      }
      if (h.recurring && hd.getUTCMonth() === m && hd.getUTCDate() === day) {
        return true;
      }
    }
    return false;
  }

  isOffDay(d: Date): boolean {
    return this.isWeekend(d) || this.isHoliday(d);
  }

  /** Next on-or-after working day. Input need not be UTC-midnight; output is UTC-midnight. */
  nextWorkingDay(d: Date): Date {
    let cur = normalizeUtcMidnight(d);
    if (!this.isOffDay(cur)) return cur;
    for (let i = 0; i < 366; i++) {
      cur = addCalendarDays(cur, 1);
      if (!this.isOffDay(cur)) return cur;
    }
    return normalizeUtcMidnight(d);
  }

  /** Add n signed working days (skips off-days). n=0 returns normalized input. */
  addWorkingDays(d: Date, n: number): Date {
    if (n === 0) return normalizeUtcMidnight(d);
    let cur = normalizeUtcMidnight(d);
    const step = n > 0 ? 1 : -1;
    let remaining = Math.abs(n);
    while (remaining > 0) {
      cur = addCalendarDays(cur, step);
      if (!this.isOffDay(cur)) remaining--;
    }
    return cur;
  }

  /** Inclusive count of working days between two UTC calendar dates. */
  countWorkingDaysInclusive(start: Date, end: Date): number {
    let from = normalizeUtcMidnight(start);
    let to = normalizeUtcMidnight(end);
    if (from.getTime() > to.getTime()) {
      const tmp = from;
      from = to;
      to = tmp;
    }
    let count = 0;
    let cur = from;
    while (cur.getTime() <= to.getTime()) {
      if (!this.isOffDay(cur)) count++;
      cur = addCalendarDays(cur, 1);
    }
    return count;
  }

  /** Last on-or-before working day strictly before off-day input (or same if already working). */
  previousWorkingDay(d: Date): Date {
    let cur = normalizeUtcMidnight(d);
    if (!this.isOffDay(cur)) return cur;
    for (let i = 0; i < 366; i++) {
      cur = addCalendarDays(cur, -1);
      if (!this.isOffDay(cur)) return cur;
    }
    return normalizeUtcMidnight(d);
  }
}

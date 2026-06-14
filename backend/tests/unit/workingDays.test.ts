import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/data/prisma.js';
import { WorkingDayCalendar, addCalendarDays } from '../../src/lib/workingDays.js';
import { resolveDueDateForScheduling } from '../../src/lib/schedulingSettings.js';

function utc(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d));
}

describe('WorkingDayCalendar', () => {
  beforeEach(async () => {
    await prisma.holiday.deleteMany();
    await prisma.instanceSetting.deleteMany({ where: { key: 'calendar.weekend' } });
  });

  afterEach(async () => {
    await prisma.holiday.deleteMany();
    await prisma.instanceSetting.deleteMany();
  });

  it('nextWorkingDay skips Thu+Fri weekend (Iranian preset)', async () => {
    await prisma.instanceSetting.create({
      data: { key: 'calendar.weekend', value: [4, 5] },
    });
    const cal = await WorkingDayCalendar.load();
    // 2026-06-05 is Friday (UTC) — off day
    const fri = utc(2026, 6, 5);
    expect(cal.isOffDay(fri)).toBe(true);
    const next = cal.nextWorkingDay(fri);
    expect(next.toISOString()).toBe(utc(2026, 6, 6).toISOString());
  });

  it('addWorkingDays counts only working days across a weekend', async () => {
    await prisma.instanceSetting.create({
      data: { key: 'calendar.weekend', value: [0, 6] },
    });
    const cal = await WorkingDayCalendar.load();
    // Mon 2026-06-08 + 5 working days → Mon 2026-06-15 (skips Sat/Sun)
    const start = utc(2026, 6, 8);
    const end = cal.addWorkingDays(start, 5);
    expect(end.toISOString()).toBe(utc(2026, 6, 15).toISOString());
  });

  it('countWorkingDaysInclusive spans weekend correctly', async () => {
    await prisma.instanceSetting.create({
      data: { key: 'calendar.weekend', value: [0, 6] },
    });
    await prisma.holiday.create({
      data: {
        date: utc(2026, 6, 10),
        name: 'Extra off',
        recurring: false,
        source: 'MANUAL',
      },
    });
    const cal = await WorkingDayCalendar.load();
    // Mon Jun 8 → Fri Jun 12: Mon,Tue,Wed,Thu,Fri = 5 working (Wed is holiday)
    const count = cal.countWorkingDaysInclusive(utc(2026, 6, 8), utc(2026, 6, 12));
    expect(count).toBe(4);
  });

  it('preserves UTC midnight through roll', async () => {
    await prisma.instanceSetting.create({
      data: { key: 'calendar.weekend', value: [4, 5] },
    });
    const cal = await WorkingDayCalendar.load();
    const rolled = cal.nextWorkingDay(utc(2026, 6, 5));
    expect(rolled.getUTCHours()).toBe(0);
    expect(rolled.getUTCMinutes()).toBe(0);
  });
});

describe('resolveDueDateForScheduling', () => {
  beforeEach(async () => {
    await prisma.instanceSetting.deleteMany({
      where: { key: { in: ['scheduling.rollOffdayDueDates', 'calendar.weekend'] } },
    });
    await prisma.holiday.deleteMany();
  });

  afterEach(async () => {
    await prisma.instanceSetting.deleteMany();
    await prisma.holiday.deleteMany();
  });

  it('does not roll when setting is off', async () => {
    await prisma.instanceSetting.create({
      data: { key: 'calendar.weekend', value: [4, 5] },
    });
    const fri = utc(2026, 6, 5);
    const res = await resolveDueDateForScheduling(fri);
    expect(res.rolled).toBeNull();
    expect(res.dueDate!.toISOString()).toBe(fri.toISOString());
  });

  it('rolls forward when setting is on and date is off-day', async () => {
    await prisma.instanceSetting.createMany({
      data: [
        { key: 'calendar.weekend', value: [4, 5] },
        { key: 'scheduling.rollOffdayDueDates', value: true },
      ],
    });
    const fri = utc(2026, 6, 5);
    const res = await resolveDueDateForScheduling(fri);
    expect(res.rolled).not.toBeNull();
    expect(res.dueDate!.toISOString()).toBe(utc(2026, 6, 6).toISOString());
  });

  it('leaves a working day untouched when setting is on', async () => {
    await prisma.instanceSetting.createMany({
      data: [
        { key: 'calendar.weekend', value: [4, 5] },
        { key: 'scheduling.rollOffdayDueDates', value: true },
      ],
    });
    const sat = utc(2026, 6, 6);
    const res = await resolveDueDateForScheduling(sat);
    expect(res.rolled).toBeNull();
    expect(res.dueDate!.toISOString()).toBe(sat.toISOString());
  });
});

describe('addCalendarDays UTC anchor', () => {
  it('does not shift UTC day boundary', () => {
    const d = utc(2026, 3, 20);
    const next = addCalendarDays(d, 1);
    expect(next.toISOString()).toBe(utc(2026, 3, 21).toISOString());
  });
});

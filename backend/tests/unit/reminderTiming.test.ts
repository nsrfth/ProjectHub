import { describe, expect, it } from 'vitest';
import {
  computeEffectiveNotifyAt,
  resolveLeadHours,
  shouldEmitDueReminder,
} from '../../src/lib/reminderTiming.js';
import { WorkingDayCalendar } from '../../src/lib/workingDays.js';

function utc(y: number, m: number, d: number, h = 0): Date {
  return new Date(Date.UTC(y, m - 1, d, h));
}

describe('resolveLeadHours', () => {
  it('prefers assignee over creator', () => {
    expect(resolveLeadHours(48, 24, 24)).toBe(48);
  });

  it('falls back to default when both null', () => {
    expect(resolveLeadHours(null, null, 24)).toBe(24);
  });
});

describe('shouldEmitDueReminder', () => {
  const floor = utc(2026, 1, 1);

  it('fires within default 24h window', () => {
    const now = utc(2026, 6, 9, 12);
    const due = utc(2026, 6, 10, 0);
    expect(shouldEmitDueReminder(now, due, 24, false, null, floor)).toBe(true);
  });

  it('does not fire beyond 24h lead', () => {
    const now = utc(2026, 6, 8, 12);
    const due = utc(2026, 6, 10, 0);
    expect(shouldEmitDueReminder(now, due, 24, false, null, floor)).toBe(false);
  });

  it('fires ~48h before due with 48h lead', () => {
    const now = utc(2026, 6, 8, 0);
    const due = utc(2026, 6, 10, 0);
    expect(shouldEmitDueReminder(now, due, 48, false, null, floor)).toBe(true);
  });

  it('fires immediately when shifted notify is in the past', () => {
    const cal = new WorkingDayCalendar([4, 5], []);
    const now = utc(2026, 6, 6, 10);
    const due = utc(2026, 6, 7, 0);
    const notify = computeEffectiveNotifyAt(due, 24, true, cal);
    expect(notify.getTime()).toBeLessThan(now.getTime());
    expect(shouldEmitDueReminder(now, due, 24, true, cal, floor)).toBe(true);
  });
});

describe('computeEffectiveNotifyAt skipOffDays', () => {
  it('shifts notify from Friday back to Wednesday when Thu+Fri are off', () => {
    const cal = new WorkingDayCalendar([4, 5], []);
    const due = utc(2026, 6, 6, 0);
    const raw = computeEffectiveNotifyAt(due, 24, false, cal);
    const shifted = computeEffectiveNotifyAt(due, 24, true, cal);
    expect(raw.toISOString()).toBe(utc(2026, 6, 5, 0).toISOString());
    expect(shifted.toISOString()).toBe(utc(2026, 6, 3, 0).toISOString());
  });
});

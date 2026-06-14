import { afterEach, describe, expect, it } from 'vitest';
import { setHolidays, setWeekendDays } from './calendar';
import { countWorkingDaysInclusive } from './workingDays';

afterEach(() => {
  setWeekendDays([0, 6]);
  setHolidays([]);
});

describe('countWorkingDaysInclusive', () => {
  it('counts 5 working days across a Sat+Sun weekend', () => {
    setWeekendDays([0, 6]);
    const count = countWorkingDaysInclusive('2026-06-08T00:00:00.000Z', '2026-06-12T00:00:00.000Z');
    expect(count).toBe(5);
  });

  it('skips a holiday in the span', () => {
    setWeekendDays([0, 6]);
    setHolidays([
      { id: '1', date: '2026-06-10T00:00:00.000Z', name: 'Off', recurring: false },
    ]);
    const count = countWorkingDaysInclusive('2026-06-08T00:00:00.000Z', '2026-06-12T00:00:00.000Z');
    expect(count).toBe(4);
  });
});

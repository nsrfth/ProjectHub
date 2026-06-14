import dataset from '../data/ir-holidays.json' with { type: 'json' };
import { jalaliToUtcMidnight } from './shamsiCalendar.js';

export type IrHolidayType = 'national' | 'religious';

export interface IrHolidayDatasetEntry {
  jalaliYear: number;
  jalaliMonth: number;
  jalaliDay: number;
  name: string;
  type: IrHolidayType;
  recurring: boolean;
}

export interface ResolvedDatasetHoliday {
  date: Date;
  dateIso: string;
  name: string;
  type: IrHolidayType;
  recurring: boolean;
}

const ENTRIES = dataset as IrHolidayDatasetEntry[];

export function listDatasetEntriesForJalaliYear(jalaliYear: number): IrHolidayDatasetEntry[] {
  return ENTRIES.filter((e) => e.jalaliYear === jalaliYear);
}

export function resolveDatasetHolidays(jalaliYear: number): ResolvedDatasetHoliday[] {
  const byDate = new Map<string, ResolvedDatasetHoliday>();
  for (const e of listDatasetEntriesForJalaliYear(jalaliYear)) {
    const date = jalaliToUtcMidnight(e.jalaliYear, e.jalaliMonth, e.jalaliDay);
    const dateIso = date.toISOString();
    if (!byDate.has(dateIso)) {
      byDate.set(dateIso, {
        date,
        dateIso,
        name: e.name,
        type: e.type,
        recurring: e.recurring,
      });
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.getTime() - b.date.getTime());
}

/** Bundled dataset metadata for docs / API. */
export const IR_HOLIDAY_DATASET_INFO = {
  provenance:
    'Offline JSON generated from npm shamsi-holidays static files (time.ir official holiday dates, years 1404–1406). Refresh yearly via backend/scripts/generate-ir-holidays.mjs.',
  jalaliYears: [1404, 1405, 1406] as const,
  converter: 'react-date-object (same library as frontend lib/shamsi.ts)',
};

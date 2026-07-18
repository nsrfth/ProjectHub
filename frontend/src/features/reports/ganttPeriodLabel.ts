import { type Calendar } from '../../lib/calendar';
import {
  formatShamsiCalendarDate,
  formatShamsiCalendarLong,
  jalaliYearOfUtcMs,
  toPersianDigits,
} from '../../lib/shamsi';
import {
  visiblePeriodEndMs,
  visiblePeriodStartMs,
  type GanttScaleMode,
  type ProjectBounds,
} from './ganttScale';

export function formatGanttPeriodLabel(
  scaleMode: GanttScaleMode,
  anchorMs: number,
  weekStartDay: number,
  fitBounds: ProjectBounds | null,
  calendar: Calendar,
): string {
  const startMs = visiblePeriodStartMs(scaleMode, anchorMs, weekStartDay, fitBounds, calendar);
  const endMs = visiblePeriodEndMs(scaleMode, anchorMs, weekStartDay, fitBounds, calendar);
  const startIso = new Date(startMs).toISOString();
  const endIso = new Date(endMs).toISOString();

  if (scaleMode === 'year') {
    if (calendar === 'GREGORIAN') {
      return String(new Date(startMs).getUTCFullYear());
    }
    // v2.5.59: read the Jalali year straight off the window start (now a real
    // Farvardin 1) instead of parsing it out of a formatted long date. The old
    // approach converted Gregorian Jan 1 — which sits in Dey of the PREVIOUS
    // Jalali year, labelling the grid one year low — and its split-on-space
    // trick also returned "2025)" whenever dual-calendar display was on.
    return toPersianDigits(String(jalaliYearOfUtcMs(startMs)));
  }

  if (scaleMode === 'month' || scaleMode === 'day') {
    if (scaleMode === 'day' && fitBounds) {
      const a = formatShamsiCalendarDate(startIso);
      const b = formatShamsiCalendarDate(endIso);
      return a && b ? `${a} → ${b}` : a ?? b ?? '';
    }
    return formatShamsiCalendarLong(startIso) ?? '';
  }

  const a = formatShamsiCalendarDate(startIso);
  const b = formatShamsiCalendarDate(endIso);
  return a && b ? `${a} – ${b}` : a ?? b ?? '';
}

import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTeams } from '@/features/teams/TeamsContext';
import { fetchCalendar, type CalendarTask } from '@/features/calendar/api';
import { getWeekendDays, isWeekend } from '@/lib/calendar';
import { formatShamsiCalendarDate } from '@/lib/shamsi';

// v1.12: Calendar views page. Reads tasks across every project in the
// current team and lays them out on a date grid. Three modes:
//
//   work-week — 5 cells starting on the first non-off-day. The off-day
//               config drives which 5 days appear AND where the cursor
//               lands (e.g. on a Western SAT_SUN config, work-week starts
//               Monday; on Iranian THU_FRI, work-week starts Saturday).
//   week      — 7 cells, always Sun..Sat. Off-days still painted red.
//   month     — 6-row grid (42 cells). Off-days red, days outside the
//               current month dimmed.
//
// Task fetch uses the `dueDate` field by default — that's the date most
// teams plan against. The picker on the toolbar lets a user switch to
// `plannedDate` for the timeliness-flavoured view.

type ViewMode = 'work-week' | 'week' | 'month';
type DateField = 'due' | 'planned';

const DAY_NAMES_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_NAMES_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function utcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function addDaysUtc(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n));
}
function addMonthsUtc(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, d.getUTCDate()));
}
function sameDayUtc(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear()
    && a.getUTCMonth() === b.getUTCMonth()
    && a.getUTCDate() === b.getUTCDate();
}

// First non-off-day on/after `from`. Used to anchor work-week mode so the
// week starts on a workday even when the cursor lands on a weekend.
function firstWorkdayOnOrAfter(from: Date, off: number[]): Date {
  let d = utcDay(from);
  for (let i = 0; i < 7; i++) {
    if (!off.includes(d.getUTCDay())) return d;
    d = addDaysUtc(d, 1);
  }
  return utcDay(from);
}

// Pick the visible date range for the chosen view, anchored at `cursor`.
function rangeFor(view: ViewMode, cursor: Date, off: number[]): { start: Date; end: Date; cells: Date[] } {
  if (view === 'work-week') {
    const start = firstWorkdayOnOrAfter(cursor, off);
    const cells: Date[] = [];
    let d = start;
    while (cells.length < 5) {
      if (!off.includes(d.getUTCDay())) cells.push(d);
      d = addDaysUtc(d, 1);
    }
    const end = addDaysUtc(cells[cells.length - 1]!, 1);
    return { start, end, cells };
  }
  if (view === 'week') {
    // Sunday-anchored week containing `cursor`. Off-day independent.
    const c = utcDay(cursor);
    const start = addDaysUtc(c, -c.getUTCDay());
    const cells = Array.from({ length: 7 }, (_, i) => addDaysUtc(start, i));
    return { start, end: addDaysUtc(start, 7), cells };
  }
  // month — 6 weeks, padded on both ends to fill the leading/trailing
  // partial rows. Sunday-leading rows.
  const first = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), 1));
  const start = addDaysUtc(first, -first.getUTCDay());
  const cells = Array.from({ length: 42 }, (_, i) => addDaysUtc(start, i));
  return { start, end: addDaysUtc(start, 42), cells };
}

function shortLabel(d: Date, monthMode: boolean): string {
  // Shamsi-aware short label for the cell header — the calendar setting
  // drives which numerals show. In month mode we just show the day number
  // (the row header already gives the month).
  if (monthMode) return String(d.getUTCDate());
  const formatted = formatShamsiCalendarDate(d.toISOString());
  return formatted ?? `${d.getUTCDate()}`;
}

export default function CalendarPage(): JSX.Element {
  const { currentTeam } = useTeams();
  const nav = useNavigate();
  const off = getWeekendDays();

  const [view, setView] = useState<ViewMode>('week');
  const [field, setField] = useState<DateField>('due');
  const [cursor, setCursor] = useState<Date>(() => utcDay(new Date()));

  const { start, end, cells } = useMemo(() => rangeFor(view, cursor, off), [view, cursor, off]);

  const { data, isFetching } = useQuery({
    queryKey: ['calendar', currentTeam?.id, start.toISOString(), end.toISOString(), field],
    queryFn: () => fetchCalendar(currentTeam!.id, {
      since: start.toISOString(),
      until: end.toISOString(),
      field,
    }),
    enabled: !!currentTeam,
  });

  // Bucket tasks into a Map<periodKey, CalendarTask[]> for O(1) per-cell lookup.
  const byDay = useMemo(() => {
    const m = new Map<string, CalendarTask[]>();
    for (const t of data?.items ?? []) {
      const iso = field === 'due' ? t.dueDate : t.plannedDate;
      if (!iso) continue;
      const k = iso.slice(0, 10);
      const arr = m.get(k) ?? [];
      arr.push(t);
      m.set(k, arr);
    }
    return m;
  }, [data, field]);

  function shift(n: number): void {
    if (view === 'month') {
      setCursor((c) => addMonthsUtc(c, n));
    } else if (view === 'week') {
      setCursor((c) => addDaysUtc(c, 7 * n));
    } else {
      // work-week — jump by 7 calendar days; rangeFor re-aligns to the
      // first workday so the visible cells always start on a workday.
      setCursor((c) => addDaysUtc(c, 7 * n));
    }
  }

  if (!currentTeam) {
    return (
      <div className="min-h-screen p-8 max-w-3xl mx-auto">
        <p className="text-sm text-slate-500">
          Select or <Link to="/teams" className="underline">create a team</Link> first.
        </p>
      </div>
    );
  }

  const monthMode = view === 'month';
  const cursorMonthLabel = new Intl.DateTimeFormat('en-US', {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  }).format(cursor);

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="mb-4">
        <h1 className="text-2xl font-semibold">Calendar</h1>
        <p className="text-sm text-slate-500">
          in <span className="font-medium">{currentTeam.name}</span> · tasks across every project
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-3">
        <div className="flex border rounded overflow-hidden text-sm">
          {(['work-week', 'week', 'month'] as ViewMode[]).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`px-3 py-1 ${view === v ? 'bg-slate-900 text-white' : 'bg-white hover:bg-slate-100'}`}
            >
              {v === 'work-week' ? 'Work-week' : v === 'week' ? 'Week' : 'Month'}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 text-sm">
          <button onClick={() => shift(-1)} className="px-2 py-1 border rounded hover:bg-slate-100">‹</button>
          <button onClick={() => setCursor(utcDay(new Date()))} className="px-3 py-1 border rounded hover:bg-slate-100">
            Today
          </button>
          <button onClick={() => shift(1)} className="px-2 py-1 border rounded hover:bg-slate-100">›</button>
        </div>
        <div className="text-sm text-slate-700 ml-2">{cursorMonthLabel}</div>
        <div className="ml-auto flex items-center gap-2 text-sm">
          <label className="text-xs text-slate-500">Date field</label>
          <select
            value={field}
            onChange={(e) => setField(e.target.value as DateField)}
            className="border rounded px-2 py-1"
          >
            <option value="due">Due date</option>
            <option value="planned">Planned date</option>
          </select>
          {isFetching && <span className="text-xs text-slate-400">loading…</span>}
        </div>
      </div>

      {/* Header row of weekday names — only meaningful in week + month modes. */}
      {view !== 'work-week' && (
        <div className="grid grid-cols-7 gap-px bg-slate-200 border border-slate-200 text-xs text-slate-600">
          {DAY_NAMES_SHORT.map((label, idx) => (
            <div
              key={idx}
              className={`bg-white text-center py-1 ${off.includes(idx) ? 'text-red-600 font-medium' : ''}`}
            >
              {label}
            </div>
          ))}
        </div>
      )}

      <div
        className={`grid gap-px bg-slate-200 border border-x border-b border-slate-200 ${
          view === 'work-week' ? 'grid-cols-5' : 'grid-cols-7'
        }`}
      >
        {cells.map((day) => {
          const k = day.toISOString().slice(0, 10);
          const tasks = byDay.get(k) ?? [];
          const off = isWeekend(day);
          const inMonth = monthMode ? day.getUTCMonth() === cursor.getUTCMonth() : true;
          const isToday = sameDayUtc(day, utcDay(new Date()));
          return (
            <div
              key={k}
              className={[
                'bg-white p-1 min-h-[110px] flex flex-col',
                off ? 'bg-red-50' : '',
                !inMonth ? 'opacity-60' : '',
              ].join(' ')}
            >
              <div className="flex items-center justify-between text-xs">
                <span className={`${off ? 'text-red-600' : 'text-slate-600'} ${isToday ? 'font-bold' : ''}`}>
                  {monthMode ? day.getUTCDate() : `${DAY_NAMES_FULL[day.getUTCDay()]} · ${shortLabel(day, false)}`}
                </span>
                {tasks.length > 0 && (
                  <span className="text-[10px] text-slate-400">{tasks.length}</span>
                )}
              </div>
              <ul className="mt-1 space-y-0.5 overflow-hidden">
                {tasks.slice(0, monthMode ? 3 : 8).map((t) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => nav(`/projects/${t.projectId}/tasks/${t.id}`)}
                      className="w-full text-left text-[11px] truncate rounded px-1 py-0.5 hover:opacity-80"
                      style={{
                        background: t.teamColor ?? '#cbd5e1',
                        color: '#fff',
                      }}
                      title={`${t.title} · ${t.projectName}`}
                    >
                      {t.title}
                    </button>
                  </li>
                ))}
                {monthMode && tasks.length > 3 && (
                  <li className="text-[10px] text-slate-400 pl-1">+{tasks.length - 3} more</li>
                )}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueries, useQuery } from '@tanstack/react-query';
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
// v1.33: scope toggle. `current` keeps the historical single-team feed;
// `all` fans out the same /teams/:teamId/calendar call across every team
// the caller is a member of and merges client-side. The per-task
// `teamColor` already shipped from the backend, so chips visually
// disambiguate teams without any new endpoint.
type Scope = 'current' | 'all';

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

const SCOPE_STORAGE_KEY = 'calendar.scope';

export default function CalendarPage(): JSX.Element {
  const { teams, currentTeam } = useTeams();
  const nav = useNavigate();
  const off = getWeekendDays();

  const [view, setView] = useState<ViewMode>('week');
  const [field, setField] = useState<DateField>('due');
  const [cursor, setCursor] = useState<Date>(() => utcDay(new Date()));
  // v1.33: persist scope choice so a user who picked "All teams" doesn't
  // get reverted to the single-team view on reload.
  const [scope, setScope] = useState<Scope>(() => {
    if (typeof window === 'undefined') return 'current';
    return window.localStorage.getItem(SCOPE_STORAGE_KEY) === 'all' ? 'all' : 'current';
  });
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(SCOPE_STORAGE_KEY, scope);
    }
  }, [scope]);

  const { start, end, cells } = useMemo(() => rangeFor(view, cursor, off), [view, cursor, off]);

  // Single-team query — original behaviour, used when scope === 'current'.
  const singleTeamQuery = useQuery({
    queryKey: ['calendar', currentTeam?.id, start.toISOString(), end.toISOString(), field],
    queryFn: () => fetchCalendar(currentTeam!.id, {
      since: start.toISOString(),
      until: end.toISOString(),
      field,
    }),
    enabled: !!currentTeam && scope === 'current',
  });

  // v1.33: cross-team fan-out. One query per team (cheap — backend already
  // narrows to the window via `since`/`until`). React Query dedupes + caches
  // each per-team feed independently, so toggling back to single-team mode
  // reuses the already-cached page.
  const multiTeamQueries = useQueries({
    queries:
      scope === 'all'
        ? teams.map((t) => ({
            queryKey: ['calendar', t.id, start.toISOString(), end.toISOString(), field] as const,
            queryFn: () =>
              fetchCalendar(t.id, {
                since: start.toISOString(),
                until: end.toISOString(),
                field,
              }),
          }))
        : [],
  });

  // Merge whichever scope is active into a single task list. Each
  // CalendarTask already carries teamId/teamName/teamColor so the chip
  // markup below doesn't need to do any per-team lookup.
  const tasks: CalendarTask[] = useMemo(() => {
    if (scope === 'all') {
      const merged: CalendarTask[] = [];
      for (const q of multiTeamQueries) {
        if (q.data?.items) merged.push(...q.data.items);
      }
      return merged;
    }
    return singleTeamQuery.data?.items ?? [];
  }, [scope, singleTeamQuery.data, multiTeamQueries]);

  const isFetching =
    scope === 'all'
      ? multiTeamQueries.some((q) => q.isFetching)
      : singleTeamQuery.isFetching;

  // Bucket tasks into a Map<periodKey, CalendarTask[]> for O(1) per-cell lookup.
  const byDay = useMemo(() => {
    const m = new Map<string, CalendarTask[]>();
    for (const t of tasks) {
      const iso = field === 'due' ? t.dueDate : t.plannedDate;
      if (!iso) continue;
      const k = iso.slice(0, 10);
      const arr = m.get(k) ?? [];
      arr.push(t);
      m.set(k, arr);
    }
    return m;
  }, [tasks, field]);

  // v1.33: per-team legend for the cross-team view — small swatches so a
  // glance at the calendar tells you which color belongs to which team.
  const teamLegend = useMemo(() => {
    if (scope !== 'all') return [];
    const seen = new Map<string, { id: string; name: string; color: string }>();
    for (const t of tasks) {
      if (!seen.has(t.teamId)) {
        seen.set(t.teamId, {
          id: t.teamId,
          name: t.teamName,
          color: t.teamColor ?? '#cbd5e1',
        });
      }
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [scope, tasks]);

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

  // v1.33: with the "All teams" scope, we don't need a `currentTeam` to be
  // selected — the user is reading every team they belong to. Only block
  // when scope is 'current' and there's no team picked, or when there are
  // no teams at all.
  if (teams.length === 0) {
    return (
      <div className="min-h-screen p-8 max-w-3xl mx-auto">
        <p className="text-sm text-slate-500">
          You aren't in any team yet.{' '}
          <Link to="/teams" className="underline">Create one</Link>.
        </p>
      </div>
    );
  }
  if (scope === 'current' && !currentTeam) {
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
          {scope === 'current' && currentTeam ? (
            <>
              in <span className="font-medium">{currentTeam.name}</span> · tasks across every project
            </>
          ) : (
            <>
              across <span className="font-medium">{teams.length}</span> team{teams.length === 1 ? '' : 's'} you belong to
            </>
          )}
        </p>
      </div>

      {/* v1.33: scope toggle. `current` = the original single-team feed.
          `all` = fan-out across every team the caller is a member of,
          merged client-side. */}
      <div className="flex border rounded overflow-hidden text-sm mb-3 w-fit">
        <button
          type="button"
          onClick={() => setScope('current')}
          className={`px-3 py-1 ${scope === 'current' ? 'bg-slate-900 text-white' : 'bg-white hover:bg-slate-100'}`}
        >
          Current team
        </button>
        <button
          type="button"
          onClick={() => setScope('all')}
          className={`px-3 py-1 ${scope === 'all' ? 'bg-slate-900 text-white' : 'bg-white hover:bg-slate-100'}`}
          title="Tasks from every team you're a member of, color-coded"
        >
          All my teams
        </button>
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

      {/* v1.33: per-team legend, only when the cross-team scope is on. */}
      {scope === 'all' && teamLegend.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600 mb-3">
          <span className="text-slate-500">Teams:</span>
          {teamLegend.map((t) => (
            <span key={t.id} className="inline-flex items-center gap-1.5">
              <span
                aria-hidden
                className="inline-block w-3 h-3 rounded-sm"
                style={{ background: t.color }}
              />
              {t.name}
            </span>
          ))}
        </div>
      )}

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

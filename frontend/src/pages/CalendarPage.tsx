import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useTeams } from '@/features/teams/TeamsContext';
import { formatShamsiCalendarDate } from '@/lib/shamsi';
import { useT } from '@/lib/i18n';
import { fetchCalendar, type CalendarTask } from '@/features/calendar/api';
import AsanaTimelineView from '@/features/calendar/timeline/AsanaTimelineView';
import { getWeekStartDay, getWeekendDays, isWeekend } from '@/lib/calendar';
import {
  addDaysUtc,
  addMonthsUtc,
  DAY_NAMES_FULL,
  getOrderedWeekdayIndices,
  getOrderedWeekdayLabels,
  rangeForCalendarView,
  sameDayUtc,
  utcDay,
  type CalendarViewMode,
} from '@/lib/calendarWeek';

// v1.12: Calendar views page. Reads tasks across every project in the
// current team and lays them out on a date grid. Three modes:
//
//   work-week — 5 cells starting on the first non-off-day. The off-day
//               config drives which 5 days appear AND where the cursor
//               lands (e.g. on a Western SAT_SUN config, work-week starts
//               Monday; on Iranian THU_FRI, work-week starts Saturday).
//   week      — 7 cells anchored at the instance work-week start day
//               (Saturday for Sat+Sun and Thu+Fri presets). Off-days red.
//   month     — 6-row grid (42 cells) with the same week-start column.
//               Off-days red, days outside the current month dimmed.
//   timeline  — Asana-style horizontal Gantt (project → task → subtask).
//
// Task fetch uses the `dueDate` field by default — that's the date most
// teams plan against. The picker on the toolbar lets a user switch to
// `plannedDate` for the timeliness-flavoured view.

type ViewMode = CalendarViewMode;
type DateField = 'due' | 'planned';
// v1.33: team selector. Either a specific team id, or 'all' to fan out
// the same /teams/:teamId/calendar call across every team the caller
// belongs to. The per-task `teamColor` already ships from the backend,
// so chips visually disambiguate teams without any new endpoint.
const ALL_TEAMS = 'all' as const;
type TeamSelection = typeof ALL_TEAMS | string;

function shortLabel(d: Date, monthMode: boolean): string {
  // Shamsi-aware short label for the cell header — the calendar setting
  // drives which numerals show. In month mode we just show the day number
  // (the row header already gives the month).
  if (monthMode) return String(d.getUTCDate());
  const formatted = formatShamsiCalendarDate(d.toISOString());
  return formatted ?? `${d.getUTCDate()}`;
}

const TEAM_STORAGE_KEY = 'calendar.selectedTeam';

export default function CalendarPage(): JSX.Element {
  const t = useT();
  // Rendered inside PlannerLayout — no duplicate page padding.
  const { teams, currentTeam } = useTeams();
  const nav = useNavigate();
  const off = getWeekendDays();
  const weekStart = getWeekStartDay(off);
  const weekdayColumns = useMemo(() => getOrderedWeekdayIndices(weekStart), [weekStart]);
  const weekdayHeaderLabels = useMemo(() => getOrderedWeekdayLabels(true, weekStart), [weekStart]);

  const [view, setView] = useState<ViewMode>('week');
  const [field, setField] = useState<DateField>('due');
  const [cursor, setCursor] = useState<Date>(() => utcDay(new Date()));
  // v1.33: persist the team selection so reloads preserve "All my teams"
  // or a specific non-current team. Reads the localStorage entry but only
  // trusts it if it still matches a known team id (or ALL_TEAMS) — handles
  // the user leaving a team between sessions.
  const [selectedTeam, setSelectedTeam] = useState<TeamSelection>(() => {
    if (typeof window === 'undefined') return currentTeam?.id ?? ALL_TEAMS;
    const stored = window.localStorage.getItem(TEAM_STORAGE_KEY);
    return stored ?? currentTeam?.id ?? ALL_TEAMS;
  });
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(TEAM_STORAGE_KEY, selectedTeam);
    }
  }, [selectedTeam]);

  // If the stored selection points at a team the user is no longer in,
  // fall back to the current team (or All) so we don't query a 403 team.
  useEffect(() => {
    if (selectedTeam === ALL_TEAMS) return;
    if (teams.length === 0) return;
    if (!teams.some((t) => t.id === selectedTeam)) {
      setSelectedTeam(currentTeam?.id ?? ALL_TEAMS);
    }
  }, [teams, selectedTeam, currentTeam?.id]);

  const isAllTeams = selectedTeam === ALL_TEAMS;
  const singleTeamId = isAllTeams ? null : selectedTeam;

  const { start, end, cells } = useMemo(
    () => rangeForCalendarView(view, cursor, off),
    [view, cursor, off],
  );

  // Single-team query — used when one specific team is selected.
  const singleTeamQuery = useQuery({
    queryKey: ['calendar', singleTeamId, start.toISOString(), end.toISOString(), field],
    queryFn: () =>
      fetchCalendar(singleTeamId!, {
        since: start.toISOString(),
        until: end.toISOString(),
        field,
      }),
    enabled: !!singleTeamId,
  });

  // v1.33: cross-team fan-out. One query per team (cheap — backend already
  // narrows to the window via `since`/`until`). React Query dedupes + caches
  // each per-team feed independently, so toggling between selections
  // reuses the already-cached page when the user lands back on it.
  const multiTeamQueries = useQueries({
    queries: isAllTeams
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
    if (isAllTeams) {
      const merged: CalendarTask[] = [];
      for (const q of multiTeamQueries) {
        if (q.data?.items) merged.push(...q.data.items);
      }
      return merged;
    }
    return singleTeamQuery.data?.items ?? [];
  }, [isAllTeams, singleTeamQuery.data, multiTeamQueries]);

  const isFetching = isAllTeams
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
    if (!isAllTeams) return [];
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
  }, [isAllTeams, tasks]);

  // Display name of the team currently selected (for the subtitle).
  const selectedTeamName = useMemo(() => {
    if (isAllTeams) return null;
    return teams.find((t) => t.id === selectedTeam)?.name ?? null;
  }, [isAllTeams, selectedTeam, teams]);

  function shift(n: number): void {
    if (view === 'month') {
      setCursor((c) => addMonthsUtc(c, n));
    } else if (view === 'week' || view === 'timeline') {
      setCursor((c) => addDaysUtc(c, 7 * n));
    } else {
      // work-week — jump by 7 calendar days; rangeFor re-aligns to the
      // first workday so the visible cells always start on a workday.
      setCursor((c) => addDaysUtc(c, 7 * n));
    }
  }

  // v1.33: the only hard prerequisite is membership in at least one team.
  // The team-picker dropdown handles every other case (specific team /
  // All my teams), and the storage-fallback effect above guarantees the
  // selection always points at a team the user is still in.
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

  const monthMode = view === 'month';
  const cursorMonthLabel = new Intl.DateTimeFormat('en-US', {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  }).format(cursor);

  return (
    <div>
      <div className="mb-4">
        <h1 className="text-2xl font-semibold">{t('planner.nav.calendar')}</h1>
        <p className="text-sm text-slate-500">
          {isAllTeams ? (
            <>
              across <span className="font-medium">{teams.length}</span> team
              {teams.length === 1 ? '' : 's'} you belong to
            </>
          ) : selectedTeamName ? (
            <>
              in <span className="font-medium">{selectedTeamName}</span> · tasks across every project
            </>
          ) : (
            'pick a team'
          )}
        </p>
      </div>

      {/* v1.33: team picker. One dropdown with every team the user belongs
          to + an "All my teams" entry. Selection persists in localStorage
          and is independent of the global currentTeam (changing it here
          does not switch the page-context team elsewhere in the app). */}
      <div className="flex items-center gap-2 mb-3 text-sm">
        <label htmlFor="calendar-team" className="text-xs text-slate-500">
          Team
        </label>
        <select
          id="calendar-team"
          value={selectedTeam}
          onChange={(e) => setSelectedTeam(e.target.value)}
          className="border rounded px-2 py-1 bg-white"
        >
          <option value={ALL_TEAMS}>All my teams</option>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
              {currentTeam?.id === t.id ? ' (current)' : ''}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-3">
        <div className="flex border rounded overflow-hidden text-sm">
          {(['work-week', 'week', 'month', 'timeline'] as ViewMode[]).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`px-3 py-1 ${view === v ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900' : 'bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700'}`}
            >
              {v === 'work-week'
                ? t('planner.calendar.workWeek')
                : v === 'week'
                  ? t('planner.calendar.week')
                  : v === 'month'
                    ? t('planner.calendar.month')
                    : t('planner.calendar.timeline')}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 text-sm">
          {view !== 'timeline' && (
            <>
              <button onClick={() => shift(-1)} className="px-2 py-1 border rounded hover:bg-slate-100">‹</button>
              <button onClick={() => setCursor(utcDay(new Date()))} className="px-3 py-1 border rounded hover:bg-slate-100">
                Today
              </button>
              <button onClick={() => shift(1)} className="px-2 py-1 border rounded hover:bg-slate-100">›</button>
            </>
          )}
        </div>
        {view !== 'timeline' && <div className="text-sm text-slate-700 ml-2">{cursorMonthLabel}</div>}
        <div className="ml-auto flex items-center gap-2 text-sm">
          {view !== 'timeline' && (
            <>
              <label className="text-xs text-slate-500">Date field</label>
              <select
                value={field}
                onChange={(e) => setField(e.target.value as DateField)}
                className="border rounded px-2 py-1"
              >
                <option value="due">Due date</option>
                <option value="planned">Planned date</option>
              </select>
            </>
          )}
          {isFetching && view !== 'timeline' && <span className="text-xs text-slate-400">loading…</span>}
        </div>
      </div>

      {/* v1.33: per-team legend, only when the cross-team scope is on. */}
      {isAllTeams && teamLegend.length > 0 && (
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

      {view === 'timeline' ? (
        <AsanaTimelineView selectedTeam={selectedTeam} teams={teams} />
      ) : (
        <>
      {/* Header row of weekday names — only meaningful in week + month modes. */}
      {view !== 'work-week' && (
        <div className="grid grid-cols-7 gap-px bg-slate-200 border border-slate-200 text-xs text-slate-600">
          {weekdayHeaderLabels.map((label, idx) => (
            <div
              key={weekdayColumns[idx]}
              className={`bg-white text-center py-1 ${off.includes(weekdayColumns[idx]!) ? 'text-red-600 font-medium' : ''}`}
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
        </>
      )}
    </div>
  );
}

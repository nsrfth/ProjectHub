import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchGantt, type GanttSubtaskRow } from '@/features/reports/ganttApi';
import { formatShamsiCalendarDate } from '@/lib/shamsi';
import { getHolidayName, isOffDay } from '@/lib/calendar';

// v1.42: per-project Gantt report page. Mounted at
// /projects/:projectId/reports/gantt (router resolves project's teamId
// from cache or via a lookup).
//
// Visual model:
//   - Header: project summary block (total tasks/subtasks, scheduled vs
//     unscheduled, project duration).
//   - Filter row: parent task, assignee, status, date range.
//   - Chart: each row is a subtask. Bars proportional to (end - start).
//     Day-level resolution (smallest practical bucket; one day = 24px).
//   - Bars are colour-coded by status; overdue (end < today, not done)
//     shows a red border.
//   - Tooltip via native `title` for v1; full popover deferred.
//   - Horizontal scroll for long projects (overflow-x: auto wrapper).
//
// Performance: rendering is pure SVG, no chart library. Up to ~500 rows
// renders fine without virtualisation; for bigger projects, we add a
// `react-window` pass as a follow-up (noted in CHANGELOG).

// Width per day in px. Increasing this widens the chart; decreasing it
// fits more days on screen but starts losing label legibility.
const DAY_PX = 28;
const ROW_HEIGHT = 28;
const HEADER_HEIGHT = 36;

// Strip the time component — every date in the system is anchored to
// UTC midnight, but parsing through Date() can drift by timezone. Use
// the UTC accessors so the math stays calendar-day-stable.
function utcDayMs(iso: string): number {
  const d = new Date(iso);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function daysBetween(startMs: number, endMs: number): number {
  return Math.round((endMs - startMs) / 86_400_000);
}

interface RouteParams extends Record<string, string | undefined> {
  projectId: string;
}

export default function ProjectGanttPage(): JSX.Element {
  const { projectId } = useParams<RouteParams>();
  // teamId comes from the project lookup below — we route by projectId
  // only because the SPA doesn't always know teamId from the URL chain.
  // We resolve it via the cross-team project list (cheap and cached).
  const { data: allProjects } = useQuery({
    queryKey: ['projects', 'all'],
    queryFn: async () => {
      const { api } = await import('@/lib/api');
      return (await api.get<Array<{ id: string; teamId: string; name: string }>>('/projects'))
        .data;
    },
  });
  const project = allProjects?.find((p) => p.id === projectId) ?? null;
  const teamId = project?.teamId ?? null;

  const { data, isLoading, error } = useQuery({
    queryKey: ['gantt', teamId, projectId],
    queryFn: () => fetchGantt(teamId!, projectId!),
    enabled: !!teamId && !!projectId,
  });

  // Filter state — task / assignee / status / date range.
  const [filterTaskId, setFilterTaskId] = useState<string>('');
  const [filterAssigneeId, setFilterAssigneeId] = useState<string>('');
  const [filterStatus, setFilterStatus] = useState<string>('');
  const [filterFromIso, setFilterFromIso] = useState<string>('');
  const [filterToIso, setFilterToIso] = useState<string>('');

  // Derived filter dropdown values from the unfiltered rows. Distinct
  // assignees / tasks / statuses harvested in one pass so the filter
  // options are always exactly what the chart can show.
  const distinctTasks = useMemo(() => {
    if (!data) return [];
    const m = new Map<string, string>();
    for (const r of data.rows) m.set(r.taskId, r.parentTaskTitle);
    return Array.from(m, ([id, name]) => ({ id, name }));
  }, [data]);

  const distinctAssignees = useMemo(() => {
    if (!data) return [];
    const m = new Map<string, string>();
    for (const r of data.rows) {
      if (r.assigneeId) m.set(r.assigneeId, r.assigneeName ?? '(unknown)');
    }
    return Array.from(m, ([id, name]) => ({ id, name }));
  }, [data]);

  const distinctStatuses = useMemo(() => {
    if (!data) return [];
    return Array.from(new Set(data.rows.map((r) => r.parentTaskStatus)));
  }, [data]);

  // The chart needs scheduled rows only. Filters narrow this set further.
  const scheduledRows = useMemo<GanttSubtaskRow[]>(() => {
    if (!data) return [];
    return data.rows
      .filter((r) => r.startDate && r.endDate)
      .filter((r) => !filterTaskId || r.taskId === filterTaskId)
      .filter((r) => !filterAssigneeId || r.assigneeId === filterAssigneeId)
      .filter((r) => !filterStatus || r.parentTaskStatus === filterStatus)
      .filter((r) => !filterFromIso || utcDayMs(r.endDate!) >= utcDayMs(filterFromIso))
      .filter((r) => !filterToIso || utcDayMs(r.startDate!) <= utcDayMs(filterToIso));
  }, [data, filterTaskId, filterAssigneeId, filterStatus, filterFromIso, filterToIso]);

  // Group scheduled rows by parent task so the chart visually clusters them.
  const grouped = useMemo(() => {
    const m = new Map<string, { title: string; status: string; rows: GanttSubtaskRow[] }>();
    for (const r of scheduledRows) {
      const g = m.get(r.taskId);
      if (g) g.rows.push(r);
      else m.set(r.taskId, { title: r.parentTaskTitle, status: r.parentTaskStatus, rows: [r] });
    }
    return Array.from(m, ([taskId, g]) => ({ taskId, ...g }));
  }, [scheduledRows]);

  // Chart axis bounds. We extend the project range by a day on each side
  // for breathing room. When no rows match, axis collapses to a single
  // day so the SVG still renders (just empty body).
  const axis = useMemo(() => {
    if (scheduledRows.length === 0) {
      const today = Date.UTC(
        new Date().getUTCFullYear(),
        new Date().getUTCMonth(),
        new Date().getUTCDate(),
      );
      return { startMs: today, endMs: today + 86_400_000, days: 1 };
    }
    let startMs = Infinity;
    let endMs = -Infinity;
    for (const r of scheduledRows) {
      const s = utcDayMs(r.startDate!);
      const e = utcDayMs(r.endDate!);
      if (s < startMs) startMs = s;
      if (e > endMs) endMs = e;
    }
    startMs -= 86_400_000;
    endMs += 86_400_000;
    return { startMs, endMs, days: daysBetween(startMs, endMs) + 1 };
  }, [scheduledRows]);

  const todayMs = Date.UTC(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth(),
    new Date().getUTCDate(),
  );

  const chartWidth = axis.days * DAY_PX;
  // Each task group gets a header row + its subtask rows.
  const chartHeight =
    HEADER_HEIGHT + grouped.reduce((acc, g) => acc + ROW_HEIGHT + g.rows.length * ROW_HEIGHT, 0);

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      <div className="mb-4">
        <div className="text-sm text-slate-500 mb-1">
          <Link to="/projects" className="hover:underline">
            ← Projects
          </Link>
        </div>
        <h1 className="text-2xl font-semibold">
          Gantt — {project?.name ?? '…'}
        </h1>
      </div>

      {isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {error && (
        <p className="text-sm text-red-600">
          Could not load the report. The project may not exist or you don't have access.
        </p>
      )}

      {data && (
        <>
          {/* Summary block — always rendered, even when empty. */}
          <section className="bg-white rounded shadow p-4 mb-4 grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
            <Summary label="Total tasks" value={data.summary.totalTasks} />
            <Summary label="Total subtasks" value={data.summary.totalSubtasks} />
            <Summary label="Scheduled" value={data.summary.scheduledSubtasks} />
            <Summary label="Unscheduled" value={data.summary.unscheduledSubtasks} />
            <Summary
              label="Duration"
              value={
                data.summary.earliestStart && data.summary.latestEnd
                  ? `${formatShamsiCalendarDate(data.summary.earliestStart) ?? '…'} → ${
                      formatShamsiCalendarDate(data.summary.latestEnd) ?? '…'
                    }`
                  : '—'
              }
            />
          </section>

          {/* Filter row */}
          <section className="bg-white rounded shadow p-4 mb-4 flex flex-wrap items-center gap-3 text-sm">
            <FilterSelect
              label="Task"
              value={filterTaskId}
              onChange={setFilterTaskId}
              options={distinctTasks.map((t) => ({ value: t.id, label: t.name }))}
            />
            <FilterSelect
              label="Assignee"
              value={filterAssigneeId}
              onChange={setFilterAssigneeId}
              options={distinctAssignees.map((a) => ({ value: a.id, label: a.name }))}
            />
            <FilterSelect
              label="Status"
              value={filterStatus}
              onChange={setFilterStatus}
              options={distinctStatuses.map((s) => ({ value: s, label: s }))}
            />
            <label className="flex items-center gap-1">
              <span className="text-slate-500">From</span>
              <input
                type="date"
                value={filterFromIso ? filterFromIso.slice(0, 10) : ''}
                onChange={(e) =>
                  setFilterFromIso(
                    e.target.value ? new Date(e.target.value).toISOString() : '',
                  )
                }
                className="rounded border-slate-300 px-2 py-1 border"
              />
            </label>
            <label className="flex items-center gap-1">
              <span className="text-slate-500">To</span>
              <input
                type="date"
                value={filterToIso ? filterToIso.slice(0, 10) : ''}
                onChange={(e) =>
                  setFilterToIso(
                    e.target.value ? new Date(e.target.value).toISOString() : '',
                  )
                }
                className="rounded border-slate-300 px-2 py-1 border"
              />
            </label>
            <button
              type="button"
              onClick={() => {
                setFilterTaskId('');
                setFilterAssigneeId('');
                setFilterStatus('');
                setFilterFromIso('');
                setFilterToIso('');
              }}
              className="ml-auto text-xs text-slate-500 hover:underline"
            >
              Clear filters
            </button>
          </section>

          {/* Chart body — empty state vs. scrollable SVG */}
          <section className="bg-white rounded shadow p-2 overflow-x-auto">
            {scheduledRows.length === 0 ? (
              <p className="text-sm text-slate-500 p-4 italic">
                No subtasks match the current filters with both startDate and endDate set.
                Add scheduling dates on subtasks (Task detail → 📅) to populate the chart.
              </p>
            ) : (
              <GanttChart
                axis={axis}
                grouped={grouped}
                chartWidth={chartWidth}
                chartHeight={chartHeight}
                todayMs={todayMs}
              />
            )}
          </section>

          {data.summary.unscheduledSubtasks > 0 && (
            <section className="mt-4 text-xs text-slate-500">
              {data.summary.unscheduledSubtasks} subtask
              {data.summary.unscheduledSubtasks === 1 ? '' : 's'} ha
              {data.summary.unscheduledSubtasks === 1 ? 's' : 've'} no scheduling dates
              and are not shown on the chart.
            </section>
          )}
        </>
      )}
    </div>
  );
}

function Summary({ label, value }: { label: string; value: string | number }): JSX.Element {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="font-medium text-slate-800">{value}</div>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}): JSX.Element {
  return (
    <label className="flex items-center gap-1">
      <span className="text-slate-500">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border-slate-300 px-2 py-1 border text-sm"
      >
        <option value="">All</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

// Status → bar fill. Matches the kanban palette spirit (TODO grey,
// IN_PROGRESS blue, REVIEW amber, DONE green). Subtask doesn't carry
// its own status today, so we colour by the parent task's status.
function statusFill(status: string, done: boolean): string {
  if (done) return '#10b981'; // emerald
  switch (status) {
    case 'IN_PROGRESS':
      return '#3b82f6'; // blue
    case 'REVIEW':
      return '#f59e0b'; // amber
    case 'DONE':
      return '#10b981';
    default:
      return '#94a3b8'; // slate (TODO + unknown)
  }
}

function GanttChart({
  axis,
  grouped,
  chartWidth,
  chartHeight,
  todayMs,
}: {
  axis: { startMs: number; endMs: number; days: number };
  grouped: Array<{ taskId: string; title: string; status: string; rows: GanttSubtaskRow[] }>;
  chartWidth: number;
  chartHeight: number;
  todayMs: number;
}): JSX.Element {
  // Build a list of "day marker" positions for the header. We render one
  // text label per day at our default zoom; for very long projects this
  // can crowd, but the simple horizontal scroll covers it. A follow-up
  // could introduce zoom controls.
  const dayMarkers: Array<{ x: number; label: string; ms: number; offDay: boolean; holidayName: string | null }> = [];
  for (let i = 0; i < axis.days; i++) {
    const ms = axis.startMs + i * 86_400_000;
    const d = new Date(ms);
    dayMarkers.push({
      x: i * DAY_PX,
      label: `${d.getUTCMonth() + 1}/${d.getUTCDate()}`,
      ms,
      offDay: isOffDay(d),
      holidayName: getHolidayName(d),
    });
  }

  // Today indicator if inside the chart's range.
  const todayInRange = todayMs >= axis.startMs && todayMs <= axis.endMs;
  const todayX = todayInRange ? daysBetween(axis.startMs, todayMs) * DAY_PX : null;

  let yCursor = HEADER_HEIGHT;

  return (
    <svg
      width={chartWidth}
      height={chartHeight}
      style={{ display: 'block', minWidth: '100%' }}
      role="img"
      aria-label="Project Gantt chart"
    >
      {/* Header day labels */}
      <g>
        {dayMarkers.map((m, i) => (
          <g key={i}>
            {m.offDay && (
              <rect x={m.x} y={0} width={DAY_PX} height={chartHeight} fill="#fef2f2" />
            )}
            <line x1={m.x} y1={0} x2={m.x} y2={chartHeight} stroke="#f1f5f9" strokeWidth={1} />
            <text x={m.x + 2} y={14} fontSize="10" fill={m.offDay ? '#dc2626' : '#64748b'}>
              {m.holidayName ? <title>{m.holidayName}</title> : null}
              {m.label}
            </text>
          </g>
        ))}
      </g>

      {/* Today marker */}
      {todayX !== null && (
        <g>
          <line x1={todayX} y1={0} x2={todayX} y2={chartHeight} stroke="#ef4444" strokeWidth={1} />
          <text x={todayX + 2} y={28} fontSize="10" fill="#ef4444">
            today
          </text>
        </g>
      )}

      {/* Rows */}
      {grouped.map((g) => {
        const groupHeaderY = yCursor;
        const groupHeader = (
          <g key={`hdr-${g.taskId}`}>
            <rect
              x={0}
              y={groupHeaderY}
              width={chartWidth}
              height={ROW_HEIGHT}
              fill="#f8fafc"
            />
            <text x={6} y={groupHeaderY + 18} fontSize="12" fontWeight={600} fill="#334155">
              {g.title}
            </text>
          </g>
        );
        yCursor += ROW_HEIGHT;
        const rowEls = g.rows.map((r) => {
          const startMs = utcDayMs(r.startDate!);
          const endMs = utcDayMs(r.endDate!);
          const x = daysBetween(axis.startMs, startMs) * DAY_PX;
          // Inclusive day range: a "Jun 1 → Jun 1" subtask shows a 1-day bar.
          const widthDays = daysBetween(startMs, endMs) + 1;
          const w = widthDays * DAY_PX - 4;
          const y = yCursor + 4;
          const overdue = !r.done && endMs < todayMs;
          const fill = statusFill(g.status, r.done);
          const durationLine =
            r.workingDayCount !== null
              ? `Duration: ${r.workingDayCount} working day(s) (${widthDays} calendar day(s))`
              : `Duration: ${widthDays} day(s)`;
          const tooltip = [
            r.title,
            `Start: ${formatShamsiCalendarDate(r.startDate) ?? ''}`,
            `End: ${formatShamsiCalendarDate(r.endDate) ?? ''}`,
            durationLine,
            r.assigneeName ? `Assignee: ${r.assigneeName}` : 'Assignee: —',
            r.technicianName ? `Technician: ${r.technicianName}` : '',
            `Status: ${g.status}${r.done ? ' / done' : ''}`,
            `Parent: ${r.parentTaskTitle}`,
          ]
            .filter(Boolean)
            .join('\n');
          const el = (
            <g key={r.id}>
              <rect
                x={x + 2}
                y={y}
                width={Math.max(2, w)}
                height={ROW_HEIGHT - 8}
                rx={3}
                ry={3}
                fill={fill}
                stroke={overdue ? '#dc2626' : 'transparent'}
                strokeWidth={overdue ? 2 : 0}
              >
                <title>{tooltip}</title>
              </rect>
              <text
                x={x + 6}
                y={y + (ROW_HEIGHT - 8) / 2 + 4}
                fontSize="11"
                fill="#ffffff"
                style={{ pointerEvents: 'none' }}
              >
                {r.title.length > Math.max(4, widthDays * 2) ? '' : r.title}
              </text>
            </g>
          );
          yCursor += ROW_HEIGHT;
          return el;
        });
        return (
          <g key={g.taskId}>
            {groupHeader}
            {rowEls}
          </g>
        );
      })}
    </svg>
  );
}

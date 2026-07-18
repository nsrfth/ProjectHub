import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { listAllProjects, type ProjectCrossTeam } from '@/features/projects/api';
import {
  barGeometry,
  buildGanttAxis,
  shiftAnchor,
  todayLineX,
  todayUtcMs,
  utcDayMs,
  type GanttAxis,
} from '@/features/reports/ganttScale';
import { formatGanttPeriodLabel } from '@/features/reports/ganttPeriodLabel';
import {
  lateStartGapDays,
  projectsTimelineRows,
} from '@/features/projects/timelineLogic';
import { formatShamsiCalendarDate } from '@/lib/shamsi';
import { getCalendar, getWeekStartDay } from '@/lib/calendar';
import { useT } from '@/lib/i18n';

// v2.5.58: "All projects — one-year timeline". One SVG row per dated project
// across every team the caller can see, on the shared 'year' Gantt axis
// (12 month columns). The signature feature is the red "late to start"
// segment: hasStarted === false with a planned start in the past paints
// var(--color-danger) from the planned start up to today.
//
// SVG note (same as ProjectGanttPage): `var()` only resolves inside a CSS
// `style`, not an SVG presentation attribute — all token colors go through
// style={{ fill/stroke }}.

const ROW_HEIGHT = 28;
const HEADER_HEIGHT = 24;

const STATUS_OPTIONS = [
  { value: 'ACTIVE', labelKey: 'projects.status.active' },
  { value: 'ON_HOLD', labelKey: 'projects.status.onHold' },
  { value: 'ARCHIVED', labelKey: 'projects.status.archived' },
] as const;

export default function ProjectsTimelinePage(): JSX.Element {
  const t = useT();
  const [anchorMs, setAnchorMs] = useState(() => todayUtcMs());
  const [teamFilter, setTeamFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('ACTIVE');

  const { data: projects = [], isLoading, isError } = useQuery({
    queryKey: ['projects', 'all'],
    queryFn: () => listAllProjects(),
  });

  const weekStartDay = getWeekStartDay();
  const todayMs = todayUtcMs();
  // v2.5.59: the 12-month axis follows the calendar preference (Jalali months
  // under SHAMSI). Changing it happens on the Preferences page, which reloads,
  // so a plain read at render is enough — no subscription needed.
  const calendar = getCalendar();

  const axis = useMemo(
    () => buildGanttAxis('year', anchorMs, weekStartDay, todayMs, null, calendar),
    [anchorMs, weekStartDay, todayMs, calendar],
  );

  const yearLabel = useMemo(
    () => formatGanttPeriodLabel('year', anchorMs, weekStartDay, null, calendar),
    [anchorMs, weekStartDay, calendar],
  );

  const teamOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects) m.set(p.teamId, p.teamName);
    return Array.from(m, ([id, name]) => ({ id, name })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }, [projects]);

  const { scheduled, unscheduled } = useMemo(
    () => projectsTimelineRows(projects, { teamId: teamFilter, status: statusFilter }),
    [projects, teamFilter, statusFilter],
  );

  return (
    <div className="p-4 md:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h1 className="text-2xl font-semibold">{t('projects.timeline.title')}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setAnchorMs((prev) => shiftAnchor('year', prev, -1))}
            className="btn btn-secondary btn-sm"
            aria-label={t('gantt.prev')}
          >
            ◀
          </button>
          <span className="text-sm font-medium min-w-[3.5rem] text-center" dir="auto">
            {yearLabel}
          </span>
          <button
            type="button"
            onClick={() => setAnchorMs((prev) => shiftAnchor('year', prev, 1))}
            className="btn btn-secondary btn-sm"
            aria-label={t('gantt.next')}
          >
            ▶
          </button>
          <select
            value={teamFilter}
            onChange={(e) => setTeamFilter(e.target.value)}
            className="input w-auto"
            aria-label={t('projects.timeline.teamFilter')}
          >
            <option value="">{t('reports.allTeams')}</option>
            {teamOptions.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="input w-auto"
            aria-label={t('projects.timeline.statusFilter')}
          >
            <option value="">{t('projects.timeline.allStatuses')}</option>
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {t(o.labelKey)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {isLoading && <p className="text-sm text-slate-500">{t('common.loading')}</p>}
      {isError && (
        <p className="text-sm text-danger" role="alert">
          {t('projects.timeline.error')}
        </p>
      )}

      {!isLoading && !isError && (
        <>
          <section className="bg-surface rounded shadow p-4">
            {scheduled.length === 0 ? (
              <p className="text-sm text-slate-500">{t('projects.timeline.empty')}</p>
            ) : (
              <div className="flex">
                {/* Fixed start column (HTML, outside the svg) — truncates and
                    mirrors correctly in RTL; the chart itself stays LTR. */}
                <div className="w-64 shrink-0 min-w-0">
                  <div style={{ height: HEADER_HEIGHT }} className="border-b border-border" />
                  {scheduled.map((p) => (
                    <div
                      key={p.id}
                      style={{ height: ROW_HEIGHT }}
                      className="flex items-center gap-2 min-w-0 border-b border-border pe-2"
                    >
                      <Link
                        to={`/projects/${p.id}/tasks`}
                        className="truncate text-sm text-text hover:underline"
                        title={p.name}
                      >
                        {p.name}
                      </Link>
                      <span className="truncate text-xs text-text-muted">{p.teamName}</span>
                    </div>
                  ))}
                </div>
                <div dir="ltr" className="flex-1 min-w-0 overflow-x-auto">
                  <TimelineChart
                    axis={axis}
                    rows={scheduled}
                    todayMs={todayMs}
                    todayLabel={t('gantt.today')}
                    ariaLabel={t('projects.timeline.title')}
                    t={t}
                  />
                </div>
              </div>
            )}
          </section>

          {unscheduled.length > 0 && (
            <section className="mt-4 text-sm text-text-muted">
              <h2 className="font-medium">
                {t('projects.timeline.unscheduled').replace('{n}', String(unscheduled.length))}
              </h2>
              <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                {unscheduled.map((p) => (
                  <li key={p.id} className="min-w-0">
                    <Link to={`/projects/${p.id}/tasks`} className="hover:underline">
                      {p.name}
                    </Link>{' '}
                    <span className="text-xs">({p.teamName})</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function barTooltip(
  p: ProjectCrossTeam,
  gapDays: number,
  t: (key: string) => string,
): string {
  const start = formatShamsiCalendarDate(p.startDate);
  const end = formatShamsiCalendarDate(p.endDate);
  const lines = [`${p.name} — ${p.teamName}`];
  if (start) lines.push(`${t('projects.startDate')}: ${start}`);
  if (end) lines.push(`${t('projects.endDate')}: ${end}`);
  if (p.progressPct !== undefined) {
    lines.push(`${t('projects.timeline.progress')}: ${p.progressPct}%`);
  }
  if (gapDays > 0 && start) {
    lines.push(
      t('projects.timeline.lateStart')
        .replace('{date}', start)
        .replace('{days}', String(gapDays)),
    );
  }
  return lines.join('\n');
}

function TimelineChart({
  axis,
  rows,
  todayMs,
  todayLabel,
  ariaLabel,
  t,
}: {
  axis: GanttAxis;
  rows: ProjectCrossTeam[];
  todayMs: number;
  todayLabel: string;
  ariaLabel: string;
  t: (key: string) => string;
}): JSX.Element {
  const chartHeight = HEADER_HEIGHT + rows.length * ROW_HEIGHT;
  const todayX = todayLineX(axis, todayMs);

  return (
    <svg
      width={axis.chartWidth}
      height={chartHeight}
      style={{ display: 'block', minWidth: '100%' }}
      role="img"
      aria-label={ariaLabel}
    >
      {/* Month columns (12 × MONTH_PX on the 'year' axis). */}
      {axis.columns.map((col, i) =>
        col.kind === 'month' ? (
          <g key={i}>
            <line
              x1={col.x}
              y1={0}
              x2={col.x}
              y2={chartHeight}
              style={{ stroke: 'var(--color-border)' }}
              strokeWidth={col.isCurrentMonth ? 2 : 1}
            />
            <text
              x={col.x + 4}
              y={14}
              fontSize="10"
              style={{ fill: 'var(--color-text-muted)' }}
            >
              {col.label}
            </text>
          </g>
        ) : null,
      )}
      <line
        x1={0}
        y1={HEADER_HEIGHT}
        x2={axis.chartWidth}
        y2={HEADER_HEIGHT}
        style={{ stroke: 'var(--color-border)' }}
        strokeWidth={1}
      />

      {rows.map((p, index) => {
        const rowY = HEADER_HEIGHT + index * ROW_HEIGHT;
        const startMs = p.startDate ? utcDayMs(p.startDate) : null;
        const endMs = p.endDate ? utcDayMs(p.endDate) : null;
        const gapDays = lateStartGapDays(p.startDate, p.hasStarted, todayMs);
        const tooltip = barTooltip(p, gapDays, t);

        const plannedGeom =
          startMs !== null && endMs !== null ? barGeometry(startMs, endMs, axis) : null;
        const startMarker =
          startMs !== null && endMs === null ? barGeometry(startMs, startMs, axis) : null;
        const endMarker =
          startMs === null && endMs !== null ? barGeometry(endMs, endMs, axis) : null;
        // Red late-start segment: planned start → min(today, year end),
        // drawn ON TOP of the planned bar at full opacity.
        const gapGeom =
          gapDays > 0 && startMs !== null
            ? barGeometry(startMs, Math.min(todayMs, axis.endMs), axis)
            : null;

        // v2.5.59: green progress fill, inset in the planned bar. Clamped to
        // the planned width so a rounding artefact can never overhang it.
        const progressPct = p.progressPct ?? 0;
        const progressWidth = plannedGeom
          ? Math.min(plannedGeom.width, Math.max(2, (plannedGeom.width * progressPct) / 100))
          : 0;

        const markerGeom = startMarker ?? endMarker;
        const markerCx = markerGeom ? markerGeom.x + markerGeom.width / 2 : null;
        const centerY = rowY + ROW_HEIGHT / 2;

        return (
          <g key={p.id}>
            <line
              x1={0}
              y1={rowY + ROW_HEIGHT}
              x2={axis.chartWidth}
              y2={rowY + ROW_HEIGHT}
              style={{ stroke: 'var(--color-border)' }}
              strokeWidth={1}
            />
            {plannedGeom && (
              <rect
                x={plannedGeom.x + 2}
                y={rowY + 6}
                width={plannedGeom.width}
                height={ROW_HEIGHT - 12}
                rx={3}
                style={{ fill: 'var(--color-primary)' }}
                opacity={0.8}
              >
                <title>{tooltip}</title>
              </rect>
            )}
            {plannedGeom && progressPct > 0 && (
              <rect
                x={plannedGeom.x + 2}
                y={rowY + 6}
                width={progressWidth}
                height={ROW_HEIGHT - 12}
                rx={3}
                style={{ fill: 'var(--color-success)' }}
              >
                <title>{tooltip}</title>
              </rect>
            )}
            {markerCx !== null && (
              <polygon
                points={`${markerCx},${centerY - 7} ${markerCx + 6},${centerY} ${markerCx},${centerY + 7} ${markerCx - 6},${centerY}`}
                style={{ fill: 'var(--color-primary)' }}
              >
                <title>{tooltip}</title>
              </polygon>
            )}
            {gapGeom && (
              <rect
                x={gapGeom.x + 2}
                y={rowY + 6}
                width={gapGeom.width}
                height={ROW_HEIGHT - 12}
                rx={3}
                style={{ fill: 'var(--color-danger)' }}
              >
                <title>{tooltip}</title>
              </rect>
            )}
          </g>
        );
      })}

      {todayX !== null && (
        <g>
          <line
            x1={todayX}
            y1={0}
            x2={todayX}
            y2={chartHeight}
            style={{ stroke: 'var(--color-danger)' }}
            strokeWidth={1}
          />
          <text
            x={todayX + 2}
            y={HEADER_HEIGHT - 4}
            fontSize="10"
            style={{ fill: 'var(--color-danger)' }}
          >
            {todayLabel}
          </text>
        </g>
      )}
    </svg>
  );
}

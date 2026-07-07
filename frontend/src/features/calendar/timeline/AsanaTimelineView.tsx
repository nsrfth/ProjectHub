import { useMemo, useRef, useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useT } from '@/lib/i18n';
import type { Team } from '@/features/teams/api';
import { startOfWeekUtc, utcDay, addDaysUtc } from '@/lib/calendarWeek';
import { getWeekStartDay, getWeekendDays, getHolidayName, isOffDay } from '@/lib/calendar';
import { useTimelineData } from './useTimelineData';
import TimelineBar, { useTimelineBarDrag } from './TimelineBar';
import DependencyLayer from './DependencyLayer';
import {
  HEADER_HEIGHT,
  ROW_HEIGHT,
  SIDEBAR_WIDTH,
  VIRTUAL_BUFFER_ROWS,
  navStepDays,
  pxPerDay,
  visibleDayCount,
} from './constants';
import { daysBetween, todayUtcMs, utcDayMs } from './utils';
import type { TimelineFilters, TimelineRow, TimelineZoom } from './types';

interface Props {
  selectedTeam: 'all' | string;
  teams: Team[];
}

function axisStartForCursor(cursor: Date, zoom: TimelineZoom): Date {
  const off = getWeekendDays();
  const weekStart = getWeekStartDay(off);
  if (zoom === 'day') return addDaysUtc(utcDay(cursor), -3);
  if (zoom === 'week') return startOfWeekUtc(cursor, weekStart);
  return new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), 1));
}

export default function AsanaTimelineView({ selectedTeam, teams }: Props): JSX.Element {
  const t = useT();
  const nav = useNavigate();
  const [cursor, setCursor] = useState<Date>(() => utcDay(new Date()));
  const [zoom, setZoom] = useState<TimelineZoom>('week');
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set());
  const [collapsedTasks, setCollapsedTasks] = useState<Set<string>>(() => new Set());
  const [filters, setFilters] = useState<TimelineFilters>({
    projectId: '',
    assigneeId: '',
    status: '',
    dateFrom: '',
    dateTo: '',
    search: '',
  });

  const dayPx = pxPerDay(zoom);
  const dayCount = visibleDayCount(zoom);
  const axisStartDate = useMemo(() => axisStartForCursor(cursor, zoom), [cursor, zoom]);
  const axisStartMs = utcDayMs(axisStartDate.toISOString());
  const axisEndMs = axisStartMs + (dayCount - 1) * 86_400_000;

  const { rows, filterOptions, isFetching } = useTimelineData({
    selectedTeam,
    teams,
    axisStartMs,
    axisEndMs,
    filters,
    collapsedProjects,
    collapsedTasks,
  });

  const chartWidth = dayCount * dayPx;
  const todayMs = todayUtcMs();
  const bodyScrollRef = useRef<HTMLDivElement>(null);
  const headerScrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);

  const chartRows = useMemo(
    () => rows.filter((r) => r.kind !== 'project' || r.hasChildren),
    [rows],
  );

  const totalBodyHeight = chartRows.length * ROW_HEIGHT;
  const { dragState, dragDeltaDays, onDragStart } = useTimelineBarDrag(chartRows, dayPx);

  const visibleRange = useMemo(() => {
    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - VIRTUAL_BUFFER_ROWS);
    const end = Math.min(
      chartRows.length,
      Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + VIRTUAL_BUFFER_ROWS,
    );
    return { start, end };
  }, [scrollTop, viewportHeight, chartRows.length]);

  const rowIndexByTaskId = useMemo(() => {
    const m = new Map<string, number>();
    chartRows.forEach((r, i) => {
      if (r.taskId && r.kind === 'task') m.set(r.taskId, i);
    });
    return m;
  }, [chartRows]);

  const dayMarkers = useMemo(() => {
    const markers: Array<{ x: number; label: string; ms: number; major: boolean; offDay: boolean; holidayName: string | null }> = [];
    for (let i = 0; i < dayCount; i++) {
      const ms = axisStartMs + i * 86_400_000;
      const d = new Date(ms);
      const isMonthStart = d.getUTCDate() === 1;
      const isWeekStart = d.getUTCDay() === getWeekStartDay();
      let label = '';
      let major = false;
      if (zoom === 'month') {
        if (isMonthStart) {
          label = new Intl.DateTimeFormat('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' }).format(d);
          major = true;
        } else if (i % 7 === 0) {
          label = String(d.getUTCDate());
        }
      } else if (zoom === 'week') {
        label = `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
        major = isWeekStart;
      } else {
        label = `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
        major = true;
      }
      markers.push({
        x: i * dayPx,
        label,
        ms,
        major,
        offDay: isOffDay(d),
        holidayName: getHolidayName(d),
      });
    }
    return markers;
  }, [dayCount, axisStartMs, dayPx, zoom]);

  const todayX =
    todayMs >= axisStartMs && todayMs <= axisEndMs
      ? daysBetween(axisStartMs, todayMs) * dayPx
      : null;

  const toggleProject = (projectId: string) => {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  const toggleTask = (taskId: string) => {
    setCollapsedTasks((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  };

  const shift = (dir: number) => {
    setCursor((c) => addDaysUtc(c, dir * navStepDays(zoom)));
  };

  const onBodyScroll = useCallback(() => {
    const el = bodyScrollRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    if (headerScrollRef.current) {
      headerScrollRef.current.scrollLeft = el.scrollLeft;
    }
  }, []);

  useEffect(() => {
    const el = bodyScrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewportHeight(el.clientHeight));
    ro.observe(el);
    setViewportHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const renderSidebarRow = (row: TimelineRow) => {
    const isCollapsed =
      row.kind === 'project'
        ? collapsedProjects.has(row.projectId)
        : row.kind === 'task' && row.taskId
          ? collapsedTasks.has(row.taskId)
          : false;

    const paddingLeft = 8 + row.depth * 16;

    return (
      <div
        key={row.id}
        className={`flex items-center gap-1 border-b border-border text-sm truncate ${
          row.kind === 'project' ? 'bg-bg font-semibold' : 'hover:bg-bg'
        }`}
        style={{ height: ROW_HEIGHT, paddingLeft }}
      >
        {(row.kind === 'project' || (row.kind === 'task' && row.hasChildren)) && (
          <button
            type="button"
            onClick={() =>
              row.kind === 'project'
                ? toggleProject(row.projectId)
                : row.taskId && toggleTask(row.taskId)
            }
            className="shrink-0 w-5 h-5 text-xs text-slate-500 hover:text-slate-800"
            aria-expanded={!isCollapsed}
          >
            {isCollapsed ? '▸' : '▾'}
          </button>
        )}
        {row.kind !== 'project' && !(row.kind === 'task' && row.hasChildren) && (
          <span className="w-5 shrink-0" aria-hidden />
        )}
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={{ background: row.teamColor }}
          aria-hidden
        />
        <button
          type="button"
          className="flex-1 text-start truncate text-text"
          onClick={() => {
            if (row.kind === 'project') {
              nav(`/projects/${row.projectId}/tasks`);
            } else if (row.taskId) {
              nav(`/projects/${row.projectId}/tasks/${row.taskId}`);
            }
          }}
          title={row.label}
        >
          {row.label}
        </button>
        {row.kind !== 'project' && !row.barStart && (
          <span className="text-[10px] text-slate-400 shrink-0 pe-2">{t('planner.calendar.timelineUnscheduled')}</span>
        )}
      </div>
    );
  };

  const visibleRows = chartRows.slice(visibleRange.start, visibleRange.end);

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 text-sm bg-surface border border-border rounded-lg p-3">
        <div className="flex border rounded overflow-hidden">
          {(['day', 'week', 'month'] as TimelineZoom[]).map((z) => (
            <button
              key={z}
              type="button"
              onClick={() => setZoom(z)}
              className={`px-3 py-1 capitalize ${
                zoom === z
                  ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                  : 'bg-surface hover:bg-bg-elevated'
              }`}
            >
              {t(`planner.calendar.timelineZoom.${z}`)}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => shift(-1)} className="px-2 py-1 border rounded hover:bg-slate-100">
            ‹
          </button>
          <button
            type="button"
            onClick={() => setCursor(utcDay(new Date()))}
            className="px-3 py-1 border rounded hover:bg-slate-100"
          >
            {t('planner.calendar.today')}
          </button>
          <button type="button" onClick={() => shift(1)} className="px-2 py-1 border rounded hover:bg-slate-100">
            ›
          </button>
        </div>
        <input
          type="search"
          placeholder={t('planner.calendar.timelineSearch')}
          value={filters.search}
          onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
          className="border rounded px-2 py-1 min-w-[140px]"
        />
        <select
          value={filters.projectId}
          onChange={(e) => setFilters((f) => ({ ...f, projectId: e.target.value }))}
          className="border rounded px-2 py-1"
        >
          <option value="">{t('planner.calendar.timelineAllProjects')}</option>
          {filterOptions.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select
          value={filters.assigneeId}
          onChange={(e) => setFilters((f) => ({ ...f, assigneeId: e.target.value }))}
          className="border rounded px-2 py-1"
        >
          <option value="">{t('planner.calendar.timelineAllAssignees')}</option>
          {filterOptions.assignees.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <select
          value={filters.status}
          onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}
          className="border rounded px-2 py-1"
        >
          <option value="">{t('planner.calendar.timelineAllStatuses')}</option>
          {filterOptions.statuses.map((s) => (
            <option key={s} value={s}>
              {s.replace('_', ' ')}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1 text-xs text-slate-500">
          {t('planner.calendar.timelineFrom')}
          <input
            type="date"
            value={filters.dateFrom ? filters.dateFrom.slice(0, 10) : ''}
            onChange={(e) =>
              setFilters((f) => ({
                ...f,
                dateFrom: e.target.value ? new Date(e.target.value).toISOString() : '',
              }))
            }
            className="border rounded px-2 py-1"
          />
        </label>
        <label className="flex items-center gap-1 text-xs text-slate-500">
          {t('planner.calendar.timelineTo')}
          <input
            type="date"
            value={filters.dateTo ? filters.dateTo.slice(0, 10) : ''}
            onChange={(e) =>
              setFilters((f) => ({
                ...f,
                dateTo: e.target.value ? new Date(e.target.value).toISOString() : '',
              }))
            }
            className="border rounded px-2 py-1"
          />
        </label>
        {(filters.projectId ||
          filters.assigneeId ||
          filters.status ||
          filters.dateFrom ||
          filters.dateTo ||
          filters.search) && (
          <button
            type="button"
            onClick={() =>
              setFilters({
                projectId: '',
                assigneeId: '',
                status: '',
                dateFrom: '',
                dateTo: '',
                search: '',
              })
            }
            className="text-xs text-slate-500 hover:underline ms-auto"
          >
            {t('planner.calendar.timelineClearFilters')}
          </button>
        )}
        {isFetching && <span className="text-xs text-slate-400">{t('planner.calendar.loading')}</span>}
      </div>

      {/* Chart shell */}
      <div className="border border-border rounded-lg bg-surface overflow-hidden">
        {chartRows.length === 0 ? (
          <p className="text-sm text-slate-500 p-6 italic">{t('planner.calendar.timelineEmpty')}</p>
        ) : (
          <div className="flex flex-col" style={{ maxHeight: 'min(70vh, 720px)' }}>
            {/* Sticky header row */}
            <div className="flex shrink-0 border-b border-border">
              <div
                className="shrink-0 border-r border-border bg-bg px-3 flex items-center text-xs font-semibold text-slate-600"
                style={{ width: SIDEBAR_WIDTH, height: HEADER_HEIGHT }}
              >
                {t('planner.calendar.timelineTasks')}
              </div>
              <div ref={headerScrollRef} className="flex-1 overflow-x-hidden">
                <div className="relative" style={{ width: chartWidth, height: HEADER_HEIGHT }}>
                  {dayMarkers.map((m, i) =>
                    m.label ? (
                      <div
                        key={i}
                        className={`absolute top-0 bottom-0 border-l border-slate-100 dark:border-slate-700 ${
                          m.offDay ? 'bg-offday' : ''
                        } ${m.major ? 'text-slate-700 font-medium' : 'text-slate-400'} ${
                          m.offDay ? 'text-text-muted' : ''
                        }`}
                        style={{ left: m.x, width: dayPx }}
                        title={m.holidayName ?? undefined}
                      >
                        <span className="text-[10px] pl-1 pt-2 inline-block whitespace-nowrap">{m.label}</span>
                      </div>
                    ) : (
                      <div
                        key={i}
                        className={`absolute top-0 bottom-0 border-l border-slate-50 dark:border-slate-800 ${
                          m.offDay ? 'bg-offday' : ''
                        }`}
                        style={{ left: m.x, width: dayPx }}
                        title={m.holidayName ?? undefined}
                      />
                    ),
                  )}
                  {todayX !== null && (
                    <div
                      className="absolute top-0 bottom-0 border-l-2 border-red-500 z-10"
                      style={{ left: todayX }}
                    >
                      <span className="text-[10px] text-red-500 pl-0.5">{t('planner.calendar.today')}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Scrollable body */}
            <div
              ref={bodyScrollRef}
              className="flex flex-1 overflow-auto"
              onScroll={onBodyScroll}
            >
              <div className="shrink-0 border-r border-border" style={{ width: SIDEBAR_WIDTH }}>
                <div style={{ height: totalBodyHeight, paddingTop: visibleRange.start * ROW_HEIGHT }}>
                  {visibleRows.map((row) => renderSidebarRow(row))}
                </div>
              </div>
              <div className="flex-1 relative min-w-0">
                <div className="relative" style={{ width: chartWidth, height: totalBodyHeight }}>
                  {/* Grid lines */}
                  {dayMarkers.map((m, i) => (
                    <div
                      key={i}
                      className={`absolute top-0 bottom-0 border-l border-slate-100 dark:border-slate-800 pointer-events-none ${
                        m.offDay ? 'bg-offday' : ''
                      }`}
                      style={{ left: m.x, width: dayPx }}
                    />
                  ))}
                  {todayX !== null && (
                    <div
                      className="absolute top-0 bottom-0 border-l-2 border-red-400/60 pointer-events-none z-[1]"
                      style={{ left: todayX }}
                    />
                  )}
                  {/* Row backgrounds */}
                  {visibleRows.map((row, vi) => {
                    const i = visibleRange.start + vi;
                    const top = i * ROW_HEIGHT;
                    return (
                      <div
                        key={row.id}
                        className={`absolute left-0 right-0 border-b border-slate-100 dark:border-slate-800 ${
                          row.kind === 'project' ? 'bg-slate-50/80 dark:bg-slate-800/40' : ''
                        }`}
                        style={{ top, height: ROW_HEIGHT }}
                      />
                    );
                  })}
                  {/* Bars */}
                  {visibleRows.map((row, vi) => {
                    const i = visibleRange.start + vi;
                    return (
                      <TimelineBar
                        key={row.id}
                        row={row}
                        axisStartMs={axisStartMs}
                        dayPx={dayPx}
                        rowTop={i * ROW_HEIGHT}
                        todayMs={todayMs}
                        onDragStart={onDragStart}
                        dragState={dragState}
                        dragDeltaDays={dragDeltaDays}
                      />
                    );
                  })}
                  <DependencyLayer
                    edges={[]}
                    rowIndexByTaskId={rowIndexByTaskId}
                    axisStartMs={axisStartMs}
                    dayPx={dayPx}
                    chartWidth={chartWidth}
                    headerHeight={0}
                    rowHeight={ROW_HEIGHT}
                  />
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
      <p className="text-xs text-slate-500">{t('planner.calendar.timelineHint')}</p>
    </div>
  );
}

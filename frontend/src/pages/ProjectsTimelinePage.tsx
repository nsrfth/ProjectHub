import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  listAllProjects,
  updateProject,
  type ProjectCrossTeam,
} from '@/features/projects/api';
import {
  lateStartGapDays,
  projectsTimelineRows,
} from '@/features/projects/timelineLogic';
import {
  GanttFeatureItem,
  GanttFeatureList,
  GanttFeatureListGroup,
  GanttHeader,
  GanttProvider,
  GanttSidebar,
  GanttSidebarGroup,
  GanttSidebarHeader,
  GanttSidebarItem,
  GanttTimeline,
  GanttToday,
  todayUtcMs,
  utcDayMs,
  type GanttFeature,
  type Range,
} from '@/components/ui/gantt';
import { formatShamsiCalendarDate } from '@/lib/shamsi';
import { getCalendar } from '@/lib/calendar';
import { jalaliYearOfUtcMs } from '@/lib/shamsi';
import { useT } from '@/lib/i18n';

// v2.5.58 → v2.22: "All projects — one-year timeline", rebuilt on the
// interactive Gantt (components/ui/gantt.tsx). What the SVG version did, this
// still does — the red "late to start" segment, the green progress fill, the
// calendar-aware axis, Shamsi tooltips, the unscheduled list. What it adds:
// drag a bar to reschedule (persisted through updateProject), resize either
// end, switch between daily / monthly / quarterly, and scroll the timeline
// into any year.
//
// Bar layers, painted in this order so the meaning survives overlap:
//   1. the Card itself      — the planned window
//   2. green progress fill  — clamped to the bar, hidden at 0%
//   3. red late-start gap   — drawn LAST so "not started" stays visible on
//                             top of "in progress"
//
// The fills are percentage-width, not pixel maths: the bar element is already
// sized by the Gantt's column geometry, so a % is exact in every range and
// calendar and cannot drift from the bar it sits in.

const MS_DAY = 86_400_000;

const STATUS_OPTIONS = [
  { value: 'ACTIVE', labelKey: 'projects.status.active' },
  { value: 'ON_HOLD', labelKey: 'projects.status.onHold' },
  { value: 'ARCHIVED', labelKey: 'projects.status.archived' },
] as const;

const RANGE_OPTIONS: Array<{ value: Range; labelKey: string }> = [
  { value: 'daily', labelKey: 'projects.timeline.range.daily' },
  { value: 'monthly', labelKey: 'projects.timeline.range.monthly' },
  { value: 'quarterly', labelKey: 'projects.timeline.range.quarterly' },
];

const STATUS_COLOR: Record<string, string> = {
  ACTIVE: 'var(--color-success)',
  ON_HOLD: 'var(--color-warning)',
  ARCHIVED: 'var(--color-text-muted)',
};

/** UTC-midnight ms for a calendar-date ISO string, or null. */
function dayMs(iso: string | null): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return utcDayMs(d);
}

/**
 * A project row needs both ends to draw. Projects carrying only one of the
 * two dates collapse to a single-day bar on the date they do have — the same
 * rows the SVG version drew as a stub.
 */
function featureBounds(p: ProjectCrossTeam): { startMs: number; endMs: number } | null {
  const start = dayMs(p.startDate);
  const end = dayMs(p.endDate);
  if (start === null && end === null) return null;
  const s = start ?? (end as number);
  const e = end ?? (start as number);
  return { startMs: Math.min(s, e), endMs: Math.max(s, e) };
}

function formatDate(ms: number): string {
  const iso = new Date(ms).toISOString();
  return formatShamsiCalendarDate(iso) ?? iso.slice(0, 10);
}

export default function ProjectsTimelinePage(): JSX.Element {
  const t = useT();
  const qc = useQueryClient();
  const calendar = getCalendar();
  const todayMs = todayUtcMs();

  const [teamFilter, setTeamFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('ACTIVE');
  const [range, setRange] = useState<Range>('monthly');
  const [anchorYear, setAnchorYear] = useState(() =>
    calendar === 'SHAMSI'
      ? jalaliYearOfUtcMs(todayUtcMs())
      : new Date(todayUtcMs()).getUTCFullYear(),
  );
  const [saveError, setSaveError] = useState<string | null>(null);

  const { data: projects = [], isLoading, isError } = useQuery({
    queryKey: ['projects', 'all'],
    queryFn: () => listAllProjects(),
  });

  const rescheduleMut = useMutation({
    mutationFn: ({
      project,
      startMs,
      endMs,
    }: {
      project: ProjectCrossTeam;
      startMs: number;
      endMs: number;
    }) =>
      updateProject(project.teamId, project.id, {
        startDate: new Date(startMs).toISOString(),
        endDate: new Date(endMs).toISOString(),
      }),
    onSuccess: () => {
      setSaveError(null);
      void qc.invalidateQueries({ queryKey: ['projects', 'all'] });
    },
    onError: () => {
      setSaveError(t('projects.timeline.saveError'));
      // Re-fetch so the dragged bar snaps back to the server's truth rather
      // than sitting at a position that was never persisted.
      void qc.invalidateQueries({ queryKey: ['projects', 'all'] });
    },
  });

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

  // Group the chart rows by team, matching the sidebar's grouping.
  const groups = useMemo(() => {
    const byTeam = new Map<string, ProjectCrossTeam[]>();
    for (const p of scheduled) {
      const list = byTeam.get(p.teamName);
      if (list) list.push(p);
      else byTeam.set(p.teamName, [p]);
    }
    return Array.from(byTeam, ([name, rows]) => ({ name, rows })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }, [scheduled]);

  const yearText = calendar === 'SHAMSI' ? String(anchorYear) : String(anchorYear);

  return (
    <div className="p-4 md:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h1 className="text-2xl font-semibold">{t('projects.timeline.title')}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setAnchorYear((y) => y - 1)}
            className="btn btn-secondary btn-sm"
            aria-label={t('gantt.prev')}
          >
            ◀
          </button>
          <span className="text-sm font-medium min-w-[3.5rem] text-center" dir="auto">
            {yearText}
          </span>
          <button
            type="button"
            onClick={() => setAnchorYear((y) => y + 1)}
            className="btn btn-secondary btn-sm"
            aria-label={t('gantt.next')}
          >
            ▶
          </button>
          <select
            value={range}
            onChange={(e) => setRange(e.target.value as Range)}
            className="input w-auto"
            aria-label={t('projects.timeline.rangeFilter')}
          >
            {RANGE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {t(o.labelKey)}
              </option>
            ))}
          </select>
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

      {isLoading && <p className="text-sm text-text-muted">{t('common.loading')}</p>}
      {isError && (
        <p className="text-sm text-danger" role="alert">
          {t('projects.timeline.error')}
        </p>
      )}
      {saveError && (
        <p className="mb-2 text-sm text-danger" role="alert">
          {saveError}
        </p>
      )}

      {!isLoading && !isError && (
        <>
          <section className="bg-surface rounded shadow overflow-hidden">
            {scheduled.length === 0 ? (
              <p className="p-4 text-sm text-text-muted">{t('projects.timeline.empty')}</p>
            ) : (
              <GanttProvider
                range={range}
                zoom={100}
                anchorYear={anchorYear}
                className="h-[32rem]"
              >
                <GanttSidebar
                  header={
                    <GanttSidebarHeader
                      nameLabel={t('projects.timeline.title')}
                      durationLabel={t('projects.timeline.teamFilter')}
                    />
                  }
                >
                  {groups.map((group) => (
                    <GanttSidebarGroup key={group.name} name={group.name}>
                      {group.rows.map((p) => {
                        const feature = toFeature(p);
                        if (!feature) return null;
                        return (
                          <GanttSidebarItem
                            key={p.id}
                            feature={feature}
                            durationLabel={p.teamName}
                          />
                        );
                      })}
                    </GanttSidebarGroup>
                  ))}
                </GanttSidebar>

                <GanttTimeline>
                  <GanttHeader />
                  <GanttFeatureList>
                    {groups.map((group) => (
                      <GanttFeatureListGroup key={group.name}>
                        {group.rows.map((p) => {
                          const feature = toFeature(p);
                          if (!feature) return null;
                          const gapDays = lateStartGapDays(p.startDate, p.hasStarted, todayMs);
                          const totalDays =
                            Math.round(
                              (utcDayMs(feature.endAt) - utcDayMs(feature.startAt)) / MS_DAY,
                            ) + 1;
                          const progressPct = p.progressPct ?? 0;
                          const gapPct = Math.min((gapDays / totalDays) * 100, 100);

                          return (
                            <GanttFeatureItem
                              key={p.id}
                              {...feature}
                              onMove={(_id, startAt, endAt) =>
                                rescheduleMut.mutate({
                                  project: p,
                                  startMs: utcDayMs(startAt),
                                  endMs: utcDayMs(endAt),
                                })
                              }
                              formatHandleLabel={(d) => formatDate(utcDayMs(d))}
                            >
                              <div
                                className="relative flex h-full w-full items-center"
                                title={barTooltip(p, gapDays, t)}
                              >
                                {/* 2 — progress, clamped to the planned bar */}
                                {progressPct > 0 && (
                                  <div
                                    className="absolute inset-y-0 left-0 rounded-s-md"
                                    style={{
                                      width: `${Math.min(progressPct, 100)}%`,
                                      background: 'var(--color-success)',
                                      opacity: 0.35,
                                    }}
                                  />
                                )}
                                {/* 3 — late-to-start gap, over the progress */}
                                {gapDays > 0 && (
                                  <div
                                    className="absolute inset-y-0 left-0 rounded-s-md"
                                    style={{
                                      width: `${gapPct}%`,
                                      background: 'var(--color-danger)',
                                      opacity: 0.55,
                                    }}
                                  />
                                )}
                                <Link
                                  to={`/projects/${p.id}/tasks`}
                                  className="relative z-[1] flex-1 truncate text-xs text-text hover:underline"
                                  dir="auto"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  {p.name}
                                </Link>
                              </div>
                            </GanttFeatureItem>
                          );
                        })}
                      </GanttFeatureListGroup>
                    ))}
                  </GanttFeatureList>
                  <GanttToday label={t('gantt.today')} dateLabel={formatDate(todayMs)} />
                </GanttTimeline>
              </GanttProvider>
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

function toFeature(p: ProjectCrossTeam): GanttFeature | null {
  const bounds = featureBounds(p);
  if (!bounds) return null;
  return {
    id: p.id,
    name: p.name,
    startAt: new Date(bounds.startMs),
    endAt: new Date(bounds.endMs),
    status: {
      id: p.status,
      name: p.status,
      color: STATUS_COLOR[p.status] ?? 'var(--color-text-muted)',
    },
  };
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

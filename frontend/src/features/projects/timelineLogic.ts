// v2.5.58: pure logic for the "All projects — one-year timeline" page
// (/projects/timeline). Kept dependency-free so the vitest suite can run it
// in a plain node environment (same pattern as projectActionsLogic.ts).
//
// Date convention: project startDate/endDate are UTC-midnight ISO datetimes
// (calendar dates, zone-neutral) — day math reads UTC components only.

const MS_DAY = 86_400_000;

/** Structural subset of ProjectCrossTeam the timeline logic needs. */
export interface TimelineProjectInput {
  id: string;
  name: string;
  teamId: string;
  teamName: string;
  status: string;
  startDate: string | null;
  endDate: string | null;
  /**
   * v2.5.58: any live task past TODO or with actualStart (cross-team list
   * only). Optional on the wire — undefined means "unknown" and must NOT be
   * flagged as late (only an explicit `false` draws the red gap).
   */
  hasStarted?: boolean;
}

/** UTC-midnight ms for a calendar-date ISO string, or null when unparsable. */
function calendarDayMs(iso: string): number | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * THE KEY FEATURE — "late to start". Number of whole days the project is
 * overdue to start: > 0 only when the backend explicitly reported
 * `hasStarted === false` AND the planned start is strictly before today.
 * 0 in every other case (started, unknown, unscheduled, starts today/future).
 */
export function lateStartGapDays(
  startDateIso: string | null | undefined,
  hasStarted: boolean | undefined,
  todayMs: number,
): number {
  if (hasStarted !== false || !startDateIso) return 0;
  const startMs = calendarDayMs(startDateIso);
  if (startMs === null || startMs >= todayMs) return 0;
  return Math.round((todayMs - startMs) / MS_DAY);
}

export interface ProjectsTimelineFilter {
  /** '' = all teams. */
  teamId: string;
  /** '' = all statuses; otherwise an exact ProjectStatus value. */
  status: string;
}

export interface ProjectsTimelineRows<P extends TimelineProjectInput> {
  /** At least one of startDate/endDate — sorted by startDate asc, nulls last. */
  scheduled: P[];
  /** Neither date set. */
  unscheduled: P[];
}

function startSortKey(p: TimelineProjectInput): number {
  if (!p.startDate) return Number.POSITIVE_INFINITY;
  return calendarDayMs(p.startDate) ?? Number.POSITIVE_INFINITY;
}

/**
 * Apply the page filters, then split into chart rows (scheduled — at least
 * one of the two dates) and the muted "unscheduled" list below the chart.
 */
export function projectsTimelineRows<P extends TimelineProjectInput>(
  projects: P[],
  filter: ProjectsTimelineFilter,
): ProjectsTimelineRows<P> {
  const visible = projects.filter(
    (p) =>
      (!filter.teamId || p.teamId === filter.teamId) &&
      (!filter.status || p.status === filter.status),
  );
  const scheduled = visible
    .filter((p) => p.startDate || p.endDate)
    .sort((a, b) => {
      const ka = startSortKey(a);
      const kb = startSortKey(b);
      if (ka !== kb) return ka - kb;
      return a.name.localeCompare(b.name);
    });
  const unscheduled = visible.filter((p) => !p.startDate && !p.endDate);
  return { scheduled, unscheduled };
}

/** Every i18n key ProjectsTimelinePage renders — asserted to exist in BOTH
 *  en.json and fa.json by timelineLogic.test.ts. */
export const PROJECTS_TIMELINE_I18N_KEYS = [
  // New (v2.5.58)
  'projects.timeline.title',
  'projects.timeline.link',
  'projects.timeline.lateStart',
  'projects.timeline.unscheduled',
  'projects.timeline.empty',
  'projects.timeline.error',
  'projects.timeline.allStatuses',
  'projects.timeline.teamFilter',
  'projects.timeline.statusFilter',
  // New (v2.5.59)
  'projects.timeline.progress',
  // Reused existing keys
  'reports.allTeams',
  'projects.status.active',
  'projects.status.onHold',
  'projects.status.archived',
  'projects.startDate',
  'projects.endDate',
  'gantt.prev',
  'gantt.next',
  'gantt.today',
  'common.loading',
] as const;

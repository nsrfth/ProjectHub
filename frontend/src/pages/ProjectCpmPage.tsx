import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  downloadCpmCsv,
  fetchCpmReport,
  MAX_NEAR_CRITICAL_DAYS,
  type CpmReportRow,
  type FloatStatus,
} from '@/features/reports/cpmApi';
import { getEffectiveConfig } from '@/features/profiles/api';
import { formatShamsiCalendarDate } from '@/lib/shamsi';
import { useT } from '@/lib/i18n';

// v2.23.0 (PMIS R5 supplement): CPM Schedule Analysis report page — the
// activity-level schedule table (ES/EF/LS/LF, total + free float, driving
// predecessor) that sits alongside the Gantt bar chart rather than inside it.

interface RouteParams extends Record<string, string | undefined> {
  projectId: string;
}

type SortKey =
  | 'wbsCode'
  | 'title'
  | 'durationDays'
  | 'earlyStart'
  | 'earlyFinish'
  | 'lateStart'
  | 'lateFinish'
  | 'totalFloatDays'
  | 'freeFloatDays';

const FLOAT_BADGE: Record<FloatStatus, string> = {
  NEGATIVE: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  CRITICAL: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
  NEAR_CRITICAL: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
  NORMAL: 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
};

const FLOAT_I18N: Record<FloatStatus, string> = {
  NEGATIVE: 'cpm.float.negative',
  CRITICAL: 'cpm.float.critical',
  NEAR_CRITICAL: 'cpm.float.nearCritical',
  NORMAL: 'cpm.float.normal',
};

const REASON_I18N: Record<string, string> = {
  NO_DATES: 'cpm.excluded.noDates',
  IS_SUMMARY: 'cpm.excluded.isSummary',
  ORPHANED_EDGE: 'cpm.excluded.orphanedEdge',
};

const FILTERS: Array<FloatStatus | 'ALL'> = [
  'ALL',
  'NEGATIVE',
  'CRITICAL',
  'NEAR_CRITICAL',
  'NORMAL',
];

/** Dotted-decimal outline comparison so 1.9 sorts before 1.10. */
function compareWbsCodes(a: string | null, b: string | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const as = a.split('.');
  const bs = b.split('.');
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const av = Number(as[i] ?? -1);
    const bv = Number(bs[i] ?? -1);
    if (av !== bv) return av - bv;
  }
  return 0;
}

export default function ProjectCpmPage(): JSX.Element {
  const { projectId } = useParams<RouteParams>();
  const t = useT();

  const [nearCriticalDays, setNearCriticalDays] = useState(3);
  const [filter, setFilter] = useState<FloatStatus | 'ALL'>('ALL');
  const [sortKey, setSortKey] = useState<SortKey>('wbsCode');
  const [sortAsc, setSortAsc] = useState(true);
  const [csvError, setCsvError] = useState<string | null>(null);

  const { data: allProjects } = useQuery({
    queryKey: ['projects', 'all'],
    queryFn: async () => {
      const { api } = await import('@/lib/api');
      return (await api.get<Array<{ id: string; teamId: string; name: string }>>('/projects')).data;
    },
  });
  const project = allProjects?.find((p) => p.id === projectId) ?? null;
  const teamId = project?.teamId ?? null;

  const { data: effectiveConfig } = useQuery({
    queryKey: ['effective-config', teamId, projectId],
    queryFn: () => getEffectiveConfig(teamId!, projectId!),
    enabled: !!teamId && !!projectId,
  });
  const cpmEnabled = effectiveConfig?.modules.cpm_schedule?.enabled ?? false;

  const { data, isLoading, error } = useQuery({
    queryKey: ['cpmReport', teamId, projectId, nearCriticalDays],
    queryFn: () => fetchCpmReport(teamId!, projectId!, nearCriticalDays),
    enabled: !!teamId && !!projectId && cpmEnabled,
  });

  const titleOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of data?.rows ?? []) m.set(r.taskId, r.title);
    return m;
  }, [data]);

  const visibleRows = useMemo(() => {
    const rows = (data?.rows ?? []).filter((r) => filter === 'ALL' || r.floatStatus === filter);
    const dir = sortAsc ? 1 : -1;
    return [...rows].sort((a, b) => {
      if (sortKey === 'wbsCode') return dir * compareWbsCodes(a.wbsCode, b.wbsCode);
      if (sortKey === 'title') return dir * a.title.localeCompare(b.title);
      if (sortKey === 'durationDays') return dir * (a.durationDays - b.durationDays);
      if (sortKey === 'totalFloatDays') return dir * (a.totalFloatDays - b.totalFloatDays);
      if (sortKey === 'freeFloatDays') return dir * (a.freeFloatDays - b.freeFloatDays);
      return dir * String(a[sortKey] ?? '').localeCompare(String(b[sortKey] ?? ''));
    });
  }, [data, filter, sortKey, sortAsc]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortAsc((v) => !v);
    else {
      setSortKey(key);
      setSortAsc(true);
    }
  }

  async function onExport() {
    if (!teamId || !projectId) return;
    setCsvError(null);
    try {
      const blob = await downloadCpmCsv(teamId, projectId, nearCriticalDays);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `cpm-${project?.name ?? projectId}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setCsvError(t('cpm.csvError'));
    }
  }

  const fmt = (iso: string | null) => formatShamsiCalendarDate(iso) ?? '—';
  // Float counts are signed; render the sign so NEGATIVE reads unambiguously
  // in RTL, where a bare leading "-" can visually detach from its number.
  const fmtFloat = (n: number) => (n < 0 ? `−${Math.abs(n)}` : String(n));

  const sortHeader = (key: SortKey, label: string, align = 'text-start') => (
    <th className={`px-3 py-2 ${align} font-medium whitespace-nowrap`}>
      <button
        type="button"
        onClick={() => toggleSort(key)}
        className="hover:underline"
        aria-sort={sortKey === key ? (sortAsc ? 'ascending' : 'descending') : 'none'}
      >
        {label}
        {sortKey === key ? (sortAsc ? ' ▲' : ' ▼') : ''}
      </button>
    </th>
  );

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link to="/projects" className="text-sm text-slate-500 hover:underline">
            ← {t('nav.projects')}
          </Link>
          {projectId && (
            <Link
              to={`/projects/${projectId}/reports/gantt`}
              className="text-sm text-slate-500 hover:underline"
            >
              {t('cpm.toGantt')}
            </Link>
          )}
        </div>
        <h1 className="text-lg font-semibold">
          {t('cpm.title')}
          {project ? ` — ${project.name}` : ''}
        </h1>
      </div>

      {!cpmEnabled && (
        <div className="rounded border border-border bg-bg-elevated p-4 text-sm">
          {t('cpm.moduleDisabled')}
        </div>
      )}

      {cpmEnabled && isLoading && <div className="text-sm text-text-muted">{t('common.loading')}</div>}
      {cpmEnabled && error && (
        <div className="rounded border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
          {t('cpm.loadError')}
        </div>
      )}

      {cpmEnabled && data && (
        <>
          {/* Header — the basis a planner checks before reading any number. */}
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label={t('cpm.summary.basis')} value={t('cpm.basis.planned')} />
            <Stat
              label={t('cpm.summary.calendar')}
              value={data.workingDaysOnly ? t('cpm.calendar.working') : t('cpm.calendar.all')}
            />
            <Stat label={t('cpm.summary.projectStart')} value={fmt(data.summary.projectStart)} />
            <Stat label={t('cpm.summary.projectFinish')} value={fmt(data.summary.projectFinish)} />
            <Stat
              label={t('cpm.summary.criticalLength')}
              value={`${data.summary.criticalPathDurationDays} ${t('cpm.days')}`}
            />
            <Stat
              label={t('cpm.summary.activities')}
              value={`${data.summary.activityCount}`}
              hint={
                data.summary.excludedCount > 0
                  ? `${data.summary.excludedCount} ${t('cpm.summary.excludedSuffix')}`
                  : undefined
              }
            />
          </div>

          {/* Controls */}
          <div className="mb-3 flex flex-wrap items-center gap-4 rounded border border-border p-3">
            <div className="flex flex-wrap items-center gap-2">
              {FILTERS.map((f) => {
                const count =
                  f === 'ALL'
                    ? data.summary.activityCount
                    : f === 'NEGATIVE'
                      ? data.summary.byFloatStatus.negative
                      : f === 'CRITICAL'
                        ? data.summary.byFloatStatus.critical
                        : f === 'NEAR_CRITICAL'
                          ? data.summary.byFloatStatus.nearCritical
                          : data.summary.byFloatStatus.normal;
                return (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setFilter(f)}
                    className={`rounded px-2.5 py-1 text-xs border ${
                      filter === f ? 'border-slate-500 font-medium' : 'border-border'
                    }`}
                  >
                    {f === 'ALL' ? t('cpm.filter.all') : t(FLOAT_I18N[f] as never)} ({count})
                  </button>
                );
              })}
            </div>

            <label className="flex items-center gap-2 text-xs">
              <span className="whitespace-nowrap">
                {t('cpm.nearCriticalDays')}: {nearCriticalDays}
              </span>
              <input
                type="range"
                min={0}
                max={MAX_NEAR_CRITICAL_DAYS}
                value={nearCriticalDays}
                onChange={(e) => setNearCriticalDays(Number(e.target.value))}
                className="w-40"
              />
            </label>

            <button
              type="button"
              onClick={() => void onExport()}
              className="ms-auto rounded border border-border px-3 py-1.5 text-sm hover:bg-bg"
            >
              {t('cpm.exportCsv')}
            </button>
          </div>
          {csvError && <div className="mb-3 text-sm text-red-700 dark:text-red-300">{csvError}</div>}

          {/* Activity table. Scrolls inside its own container so the page body
              never scrolls horizontally. */}
          <div className="overflow-x-auto rounded border border-border">
            <table className="w-full text-sm">
              <thead className="bg-bg-elevated text-text-muted">
                <tr>
                  {sortHeader('wbsCode', t('cpm.col.wbs'))}
                  {sortHeader('title', t('cpm.col.activity'))}
                  {sortHeader('durationDays', t('cpm.col.duration'), 'text-end')}
                  {sortHeader('earlyStart', t('cpm.col.earlyStart'))}
                  {sortHeader('earlyFinish', t('cpm.col.earlyFinish'))}
                  {sortHeader('lateStart', t('cpm.col.lateStart'))}
                  {sortHeader('lateFinish', t('cpm.col.lateFinish'))}
                  {sortHeader('totalFloatDays', t('cpm.col.totalFloat'), 'text-end')}
                  {sortHeader('freeFloatDays', t('cpm.col.freeFloat'), 'text-end')}
                  <th className="px-3 py-2 text-start font-medium whitespace-nowrap">
                    {t('cpm.col.status')}
                  </th>
                  <th className="px-3 py-2 text-start font-medium whitespace-nowrap">
                    {t('cpm.col.driver')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((r: CpmReportRow) => (
                  <tr key={r.taskId} className="border-t border-border">
                    <td className="px-3 py-2 font-mono text-xs text-text-muted" dir="ltr">
                      {r.wbsCode ?? '—'}
                    </td>
                    <td className="px-3 py-2">
                      {r.isMilestone && <span className="me-1" title={t('cpm.milestone')}>◆</span>}
                      {r.title}
                    </td>
                    <td className="px-3 py-2 text-end tabular-nums">{r.durationDays}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{fmt(r.earlyStart)}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{fmt(r.earlyFinish)}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{fmt(r.lateStart)}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{fmt(r.lateFinish)}</td>
                    <td className="px-3 py-2 text-end tabular-nums">{fmtFloat(r.totalFloatDays)}</td>
                    <td className="px-3 py-2 text-end tabular-nums">{fmtFloat(r.freeFloatDays)}</td>
                    <td className="px-3 py-2">
                      <span className={`rounded px-2 py-0.5 text-xs ${FLOAT_BADGE[r.floatStatus]}`}>
                        {t(FLOAT_I18N[r.floatStatus] as never)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-text-muted">
                      {r.drivingPredecessorId
                        ? titleOf.get(r.drivingPredecessorId) ?? r.drivingPredecessorId
                        : '—'}
                    </td>
                  </tr>
                ))}
                {visibleRows.length === 0 && (
                  <tr>
                    <td colSpan={11} className="px-3 py-6 text-center text-text-muted">
                      {t('cpm.empty')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Critical path in longest-path order — milestones inline. */}
          {data.criticalPath.length > 0 && (
            <div className="mt-4 rounded border border-border p-3">
              <h2 className="mb-2 text-sm font-medium">{t('cpm.criticalPath')}</h2>
              <ol className="flex flex-wrap items-center gap-x-1 gap-y-2 text-sm">
                {data.criticalPath.map((id, i) => (
                  <li key={id} className="flex items-center gap-1">
                    <span className="rounded bg-bg-elevated px-2 py-0.5">
                      {titleOf.get(id) ?? id}
                    </span>
                    {i < data.criticalPath.length - 1 && (
                      <span className="text-text-muted rtl:rotate-180">→</span>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          )}

          {/* Exclusions — activities left out of the network, and activities
              whose float rests on a severed chain. Never silent. */}
          {data.excluded.length > 0 && (
            <div className="mt-4 rounded border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950">
              <h2 className="mb-2 text-sm font-medium">{t('cpm.excluded.title')}</h2>
              <p className="mb-2 text-xs text-text-muted">{t('cpm.excluded.help')}</p>
              <ul className="space-y-1 text-sm">
                {data.excluded.map((x, i) => (
                  <li key={`${x.taskId}-${x.reason}-${i}`} className="flex flex-wrap gap-2">
                    <span>{x.title || x.taskId}</span>
                    <span className="text-text-muted">
                      — {t(REASON_I18N[x.reason] as never)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}): JSX.Element {
  return (
    <div className="rounded border border-border p-2">
      <div className="text-xs text-text-muted">{label}</div>
      <div className="text-sm font-medium">{value}</div>
      {hint && <div className="text-xs text-text-muted">{hint}</div>}
    </div>
  );
}

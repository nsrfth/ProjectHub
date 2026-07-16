import { useMemo, useState } from 'react';
import { useQuery, useQueries } from '@tanstack/react-query';
import {
  Bar,
  BarChart,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useTeams } from '@/features/teams/TeamsContext';
import { listProjects } from '@/features/projects/api';
import {
  fetchWorkloadDetail,
  fetchWorkloadDrill,
  fetchWorkloadSubtaskDetail,
  type WorkloadDetailRow,
  type WorkloadDrillParams,
  type WorkloadDueBucket,
  type WorkloadSubtaskDetailRow,
  type WorkloadWindow,
} from '@/features/reports/api';
import SlideOver from '@/features/ui/SlideOver';
import WorkloadTaskList from '@/features/reports/WorkloadTaskList';
import { useT } from '@/lib/i18n';

const BUCKET_KEYS = ['overdue', 'this_week', 'next_week', 'later', 'no_due'] as const;
const BUCKET_COLORS: Record<(typeof BUCKET_KEYS)[number], string> = {
  overdue: '#ef4444',
  this_week: '#f59e0b',
  next_week: '#3b82f6',
  later: '#94a3b8',
  no_due: '#64748b',
};

const STATUS_KEYS = ['TODO', 'IN_PROGRESS', 'ON_HOLD', 'REVIEW', 'PENDING_APPROVAL'] as const;
type OpenStatus = (typeof STATUS_KEYS)[number];

const STATUS_COLORS: Record<OpenStatus, string> = {
  TODO: '#94a3b8',
  IN_PROGRESS: '#3b82f6',
  ON_HOLD: '#d97706',
  REVIEW: '#f59e0b',
  PENDING_APPROVAL: '#a855f7',
};

type LoadBy = 'bucket' | 'status' | 'subtasks';

interface MergedSubtaskRow extends WorkloadSubtaskDetailRow {
  _teamIds: string[];
}

const SUBTASK_COLORS = { open: '#3b82f6', done: '#22c55e' } as const;
type SortKey = 'name' | 'total' | 'overdue';

// WorkloadDetailRow extended to track which teams contributed to this row
// (needed for drill-through in "all teams" mode).
interface MergedRow extends WorkloadDetailRow {
  _teamIds: string[];
}

type DrillTarget = {
  kind: 'all' | 'status' | 'bucket';
  userId: string | null;
  memberName: string | null;
  teamIds: string[];
  status?: OpenStatus;
  bucket?: (typeof BUCKET_KEYS)[number];
};

export function isOverAllocated(
  row: WorkloadDetailRow,
  threshold: number,
  weighted: boolean,
): boolean {
  if (threshold <= 0) return false;
  const value = weighted ? row.weightedTotal : row.total;
  return value > threshold;
}

export default function WorkloadPage(): JSX.Element {
  const { teams, currentTeam } = useTeams();
  const t = useT();
  const [selectedTeamId, setSelectedTeamId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [window, setWindow] = useState<WorkloadWindow>('all');
  const [weighted, setWeighted] = useState(false);
  const [threshold, setThreshold] = useState(5);
  const [sortKey, setSortKey] = useState<SortKey>('total');
  const [sortAsc, setSortAsc] = useState(false);
  const [drill, setDrill] = useState<DrillTarget | null>(null);
  const [loadBy, setLoadBy] = useState<LoadBy>('bucket');

  const isAllTeams = selectedTeamId === '__all__';
  const effectiveTeamId = isAllTeams ? '' : (selectedTeamId || currentTeam?.id || '');

  // Which team IDs to fetch workload for
  const teamIdsToFetch = useMemo(
    () => (isAllTeams ? teams.map((tm) => tm.id) : effectiveTeamId ? [effectiveTeamId] : []),
    [isAllTeams, teams, effectiveTeamId],
  );

  const { data: projects } = useQuery({
    queryKey: ['projects', effectiveTeamId],
    queryFn: () => listProjects(effectiveTeamId),
    enabled: !!effectiveTeamId && !isAllTeams,
  });

  const workloadQueries = useQueries({
    queries: loadBy !== 'subtasks' ? teamIdsToFetch.map((tid) => ({
      queryKey: ['workload-detail', tid, isAllTeams ? '' : projectId, window, weighted],
      queryFn: () =>
        fetchWorkloadDetail(tid, {
          projectId: isAllTeams ? undefined : (projectId || undefined),
          window,
          weighted,
        }),
    })) : [],
  });

  const subtaskWorkloadQueries = useQueries({
    queries: loadBy === 'subtasks' ? teamIdsToFetch.map((tid) => ({
      queryKey: ['workload-subtask-detail', tid, isAllTeams ? '' : projectId],
      queryFn: () =>
        fetchWorkloadSubtaskDetail(tid, {
          projectId: isAllTeams ? undefined : (projectId || undefined),
        }),
    })) : [],
  });

  const isLoading = loadBy === 'subtasks'
    ? subtaskWorkloadQueries.some((q) => q.isLoading)
    : workloadQueries.some((q) => q.isLoading);

  // Merge results from all team queries by userId
  const rows: MergedRow[] = useMemo(() => {
    const merged = new Map<string, MergedRow>();

    teamIdsToFetch.forEach((tid, i) => {
      const items = workloadQueries[i]?.data?.items ?? [];
      for (const item of items) {
        const key = item.userId ?? '__unassigned__';
        if (!merged.has(key)) {
          merged.set(key, {
            ...item,
            openByStatus: { ...item.openByStatus },
            byDueBucket: { ...item.byDueBucket },
            _teamIds: [tid],
          });
        } else {
          const m = merged.get(key)!;
          m.total += item.total;
          m.weightedTotal += item.weightedTotal;
          m.openByStatus.TODO += item.openByStatus.TODO;
          m.openByStatus.IN_PROGRESS += item.openByStatus.IN_PROGRESS;
          m.openByStatus.ON_HOLD += item.openByStatus.ON_HOLD;
          m.openByStatus.REVIEW += item.openByStatus.REVIEW;
          m.openByStatus.PENDING_APPROVAL += item.openByStatus.PENDING_APPROVAL;
          m.byDueBucket.overdue += item.byDueBucket.overdue;
          m.byDueBucket.this_week += item.byDueBucket.this_week;
          m.byDueBucket.next_week += item.byDueBucket.next_week;
          m.byDueBucket.later += item.byDueBucket.later;
          m.byDueBucket.no_due += item.byDueBucket.no_due;
          m._teamIds.push(tid);
        }
      }
    });

    const items = [...merged.values()];
    items.sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'name') {
        cmp = (a.name ?? '').localeCompare(b.name ?? '');
      } else if (sortKey === 'overdue') {
        cmp = a.byDueBucket.overdue - b.byDueBucket.overdue;
      } else {
        const av = weighted ? a.weightedTotal : a.total;
        const bv = weighted ? b.weightedTotal : b.total;
        cmp = av - bv;
      }
      return sortAsc ? cmp : -cmp;
    });
    return items;
  }, [workloadQueries, teamIdsToFetch, sortKey, sortAsc, weighted]);

  const subtaskRows: MergedSubtaskRow[] = useMemo(() => {
    const merged = new Map<string, MergedSubtaskRow>();
    teamIdsToFetch.forEach((tid, i) => {
      const items = subtaskWorkloadQueries[i]?.data?.items ?? [];
      for (const item of items) {
        const key = item.userId ?? '__unassigned__';
        if (!merged.has(key)) {
          merged.set(key, { ...item, _teamIds: [tid] });
        } else {
          const m = merged.get(key)!;
          m.openSubtasks += item.openSubtasks;
          m.doneSubtasks += item.doneSubtasks;
          m.total += item.total;
          m._teamIds.push(tid);
        }
      }
    });
    const items = [...merged.values()];
    items.sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'name') cmp = (a.name ?? '').localeCompare(b.name ?? '');
      else cmp = a.total - b.total;
      return sortAsc ? cmp : -cmp;
    });
    return items;
  }, [subtaskWorkloadQueries, teamIdsToFetch, sortKey, sortAsc]);

  const chartData = useMemo(() => {
    if (loadBy === 'subtasks') {
      return subtaskRows.map((r) => ({
        name: r.name ?? t('workload.unassigned'),
        open: r.openSubtasks,
        done: r.doneSubtasks,
      }));
    }
    if (loadBy === 'status') {
      return rows.map((r) => ({
        name: r.name ?? t('workload.unassigned'),
        TODO: r.openByStatus.TODO,
        IN_PROGRESS: r.openByStatus.IN_PROGRESS,
        ON_HOLD: r.openByStatus.ON_HOLD,
        REVIEW: r.openByStatus.REVIEW,
        PENDING_APPROVAL: r.openByStatus.PENDING_APPROVAL,
      }));
    }
    return rows.map((r) => ({
      name: r.name ?? t('workload.unassigned'),
      overdue: r.byDueBucket.overdue,
      this_week: r.byDueBucket.this_week,
      next_week: r.byDueBucket.next_week,
      later: r.byDueBucket.later,
      no_due: r.byDueBucket.no_due,
    }));
  }, [rows, subtaskRows, t, loadBy]);

  const drillParams = useMemo((): WorkloadDrillParams | null => {
    if (!drill) return null;
    const base: WorkloadDrillParams = {
      assigneeId: drill.userId ?? '__unassigned__',
      projectId: isAllTeams ? undefined : (projectId || undefined),
    };
    if (drill.kind === 'status') return { ...base, status: drill.status };
    if (drill.kind === 'bucket') return { ...base, dueBucket: drill.bucket as WorkloadDueBucket };
    return base;
  }, [drill, projectId, isAllTeams]);

  // Drill across all relevant team IDs in parallel
  const drillQueries = useQueries({
    queries: drill && drillParams
      ? drill.teamIds.map((tid) => ({
          queryKey: ['workload-drill', tid, drillParams],
          queryFn: () => fetchWorkloadDrill(tid, drillParams!),
        }))
      : [],
  });

  const drillItems = drillQueries.flatMap((q) => q.data?.items ?? []);
  const drillLoading = drill !== null && drillQueries.some((q) => q.isLoading);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortAsc((v) => !v);
    else { setSortKey(key); setSortAsc(false); }
  }

  function drillTitle(): string {
    if (!drill) return '';
    const name = drill.memberName ?? t('workload.unassigned');
    if (drill.kind === 'status') return `${name} — ${t(`workload.status.${drill.status!.toLowerCase()}`)}`;
    if (drill.kind === 'bucket') return `${name} — ${t(`workload.bucket.${drill.bucket}`)}`;
    return `${name} — ${t('workload.table.total')}`;
  }

  const hasData = !isLoading && (loadBy === 'subtasks' ? subtaskRows.length > 0 : rows.length > 0);

  if (!currentTeam) {
    return (
      <div className="p-8">
        <p className="text-sm text-slate-500">{t('workload.selectTeam')}</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-4 md:p-8 space-y-6">
      <header>
        <h1 className="text-2xl font-bold">{t('workload.title')}</h1>
        <p className="text-sm text-slate-500 mt-1">{t('workload.subtitle')}</p>
      </header>

      {/* Filter bar */}
      <div className="flex flex-wrap gap-4 items-end bg-surface rounded-lg shadow p-4">
        {/* Team selector */}
        <label className="text-xs block">
          {t('workload.filter.team')}
          <select
            className="mt-1 block rounded border px-2 py-1.5 text-sm dark:bg-slate-900 min-w-[160px]"
            value={selectedTeamId || currentTeam?.id || ''}
            onChange={(e) => {
              setSelectedTeamId(e.target.value);
              setProjectId('');
            }}
          >
            <option value="__all__">{t('workload.filter.allTeams')}</option>
            {teams.map((tm) => (
              <option key={tm.id} value={tm.id}>
                {tm.name}
              </option>
            ))}
          </select>
        </label>

        {/* Project selector — hidden in all-teams mode */}
        {!isAllTeams && (
          <label className="text-xs block">
            {t('workload.filter.project')}
            <select
              className="mt-1 block rounded border px-2 py-1.5 text-sm dark:bg-slate-900 min-w-[160px]"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
            >
              <option value="">{t('workload.filter.allProjects')}</option>
              {(projects ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {/* Load by */}
        <label className="text-xs block">
          {t('workload.loadBy')}
          <select
            className="mt-1 block rounded border px-2 py-1.5 text-sm dark:bg-slate-900 min-w-[130px]"
            value={loadBy}
            onChange={(e) => setLoadBy(e.target.value as LoadBy)}
          >
            <option value="bucket">{t('workload.loadBy.bucket')}</option>
            <option value="status">{t('workload.loadBy.status')}</option>
            <option value="subtasks">{t('workload.loadBy.subtasks')}</option>
          </select>
        </label>

        {/* window + weighted only apply to task-based modes */}
        {loadBy !== 'subtasks' && (
          <>
            <label className="text-xs block">
              {t('workload.filter.window')}
              <select
                className="mt-1 block rounded border px-2 py-1.5 text-sm dark:bg-slate-900 min-w-[140px]"
                value={window}
                onChange={(e) => setWindow(e.target.value as WorkloadWindow)}
              >
                <option value="all">{t('workload.window.all')}</option>
                <option value="overdue">{t('workload.window.overdue')}</option>
                <option value="this_week">{t('workload.window.this_week')}</option>
                <option value="next_week">{t('workload.window.next_week')}</option>
              </select>
            </label>

            <label className="flex items-center gap-2 text-sm pb-1">
              <input type="checkbox" checked={weighted} onChange={(e) => setWeighted(e.target.checked)} />
              {t('workload.weighted')}
            </label>
          </>
        )}

        <label className="text-xs block">
          {t('workload.threshold')}
          <input
            type="number"
            min={0}
            className="mt-1 block w-20 rounded border px-2 py-1.5 text-sm dark:bg-slate-900"
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value) || 0)}
          />
        </label>
      </div>

      {isLoading && <p className="text-sm text-slate-500">{t('workload.loading')}</p>}

      {!isLoading && !hasData && (
        <p className="text-sm text-slate-500 italic">{t('workload.empty')}</p>
      )}

      {hasData && (
        <>
          <section className="bg-surface rounded-lg shadow p-4">
            <h2 className="text-sm font-semibold mb-4">
              {loadBy === 'subtasks'
                ? t('workload.chartTitle.subtasks')
                : loadBy === 'status'
                  ? t('workload.chartTitle.status')
                  : t('workload.chartTitle')}
            </h2>
            <div dir="ltr">
              <ResponsiveContainer
                width="100%"
                height={Math.max(280, (loadBy === 'subtasks' ? subtaskRows : rows).length * 36)}
              >
                <BarChart data={chartData} layout="vertical" margin={{ left: 8, right: 16 }}>
                  <XAxis type="number" allowDecimals={false} tick={{ fontSize: 10 }} />
                  <YAxis type="category" dataKey="name" width={120} tick={{ fontSize: 10 }} />
                  <Tooltip />
                  <Legend />
                  {loadBy === 'subtasks' ? (
                    <>
                      <Bar dataKey="open" stackId="sub" fill={SUBTASK_COLORS.open} name={t('workload.table.openSubtasks')} />
                      <Bar dataKey="done" stackId="sub" fill={SUBTASK_COLORS.done} name={t('workload.table.doneSubtasks')} />
                    </>
                  ) : loadBy === 'status'
                    ? STATUS_KEYS.map((key) => (
                        <Bar
                          key={key}
                          dataKey={key}
                          stackId="load"
                          fill={STATUS_COLORS[key]}
                          name={t(`workload.status.${key.toLowerCase()}`)}
                        />
                      ))
                    : BUCKET_KEYS.map((key) => (
                        <Bar
                          key={key}
                          dataKey={key}
                          stackId="due"
                          fill={BUCKET_COLORS[key]}
                          name={t(`workload.bucket.${key}`)}
                        />
                      ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section className="bg-surface rounded-lg shadow overflow-x-auto">
            {loadBy === 'subtasks' ? (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-start text-slate-500 border-b border-border">
                    <th className="p-3 cursor-pointer" onClick={() => toggleSort('name')}>
                      {t('workload.table.member')}
                    </th>
                    <th className="p-3 text-end">{t('workload.table.openSubtasks')}</th>
                    <th className="p-3 text-end">{t('workload.table.doneSubtasks')}</th>
                    <th className="p-3 cursor-pointer text-end" onClick={() => toggleSort('total')}>
                      {t('workload.table.total')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {subtaskRows.map((r) => (
                    <tr key={r.userId ?? '__unassigned__'} className="border-b border-border">
                      <td className="p-3">{r.name ?? t('workload.unassigned')}</td>
                      <td className="p-3 text-end tabular-nums" style={{ color: SUBTASK_COLORS.open }}>
                        {r.openSubtasks}
                      </td>
                      <td className="p-3 text-end tabular-nums" style={{ color: SUBTASK_COLORS.done }}>
                        {r.doneSubtasks}
                      </td>
                      <td className="p-3 text-end tabular-nums font-medium">{r.total}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-start text-slate-500 border-b border-border">
                    <th className="p-3 cursor-pointer" onClick={() => toggleSort('name')}>
                      {t('workload.table.member')}
                    </th>
                    <th className="p-3 cursor-pointer text-end" onClick={() => toggleSort('total')}>
                      {weighted ? t('workload.table.weighted') : t('workload.table.total')}
                    </th>
                    <th className="p-3 cursor-pointer text-end" onClick={() => toggleSort('overdue')}>
                      {t('workload.bucket.overdue')}
                    </th>
                    {BUCKET_KEYS.filter((k) => k !== 'overdue').map((key) => (
                      <th key={key} className="p-3 text-end hidden md:table-cell">
                        {t(`workload.bucket.${key}`)}
                      </th>
                    ))}
                    {STATUS_KEYS.map((s) => (
                      <th key={s} className="p-3 text-end hidden lg:table-cell text-xs font-normal">
                        {t(`workload.status.${s.toLowerCase()}`)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const over = isOverAllocated(r, threshold, weighted);
                    const displayTotal = weighted ? r.weightedTotal : r.total;
                    return (
                      <tr
                        key={r.userId ?? '__unassigned__'}
                        className={['border-b border-border', over ? 'bg-danger/10' : ''].join(' ')}
                      >
                        <td className="p-3">
                          {r.name ?? t('workload.unassigned')}
                          {over && (
                            <span className="ms-2 text-xs text-danger">
                              {t('workload.overAllocated')}
                            </span>
                          )}
                        </td>
                        <td className="p-3 text-end tabular-nums font-medium">
                          <button
                            className="hover:underline hover:text-primary"
                            onClick={() => setDrill({ kind: 'all', userId: r.userId, memberName: r.name, teamIds: r._teamIds })}
                          >
                            {displayTotal}
                          </button>
                        </td>
                        <td className="p-3 text-end tabular-nums">
                          <button
                            className="hover:underline hover:text-primary"
                            onClick={() => setDrill({ kind: 'bucket', userId: r.userId, memberName: r.name, teamIds: r._teamIds, bucket: 'overdue' })}
                          >
                            {r.byDueBucket.overdue}
                          </button>
                        </td>
                        {BUCKET_KEYS.filter((k) => k !== 'overdue').map((key) => (
                          <td key={key} className="p-3 text-end tabular-nums hidden md:table-cell">
                            <button
                              className="hover:underline hover:text-primary"
                              onClick={() => setDrill({ kind: 'bucket', userId: r.userId, memberName: r.name, teamIds: r._teamIds, bucket: key })}
                            >
                              {r.byDueBucket[key]}
                            </button>
                          </td>
                        ))}
                        {STATUS_KEYS.map((s) => (
                          <td key={s} className="p-3 text-end tabular-nums hidden lg:table-cell">
                            <button
                              className="hover:underline hover:text-primary"
                              onClick={() => setDrill({ kind: 'status', userId: r.userId, memberName: r.name, teamIds: r._teamIds, status: s })}
                            >
                              {r.openByStatus[s]}
                            </button>
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}

      {drill && (
        <SlideOver title={drillTitle()} onClose={() => setDrill(null)}>
          <WorkloadTaskList tasks={drillItems} isLoading={drillLoading} />
        </SlideOver>
      )}
    </div>
  );
}

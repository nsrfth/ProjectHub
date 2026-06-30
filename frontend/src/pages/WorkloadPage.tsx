import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
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
  type WorkloadDetailRow,
  type WorkloadDrillParams,
  type WorkloadDueBucket,
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

const STATUS_KEYS = ['TODO', 'IN_PROGRESS', 'REVIEW', 'PENDING_APPROVAL'] as const;
type OpenStatus = (typeof STATUS_KEYS)[number];

type SortKey = 'name' | 'total' | 'overdue';

type DrillTarget =
  | { kind: 'status'; userId: string | null; memberName: string | null; status: OpenStatus }
  | { kind: 'bucket'; userId: string | null; memberName: string | null; bucket: (typeof BUCKET_KEYS)[number] }
  | { kind: 'all'; userId: string | null; memberName: string | null };

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

  const teamId = selectedTeamId || currentTeam?.id;

  const { data: projects } = useQuery({
    queryKey: ['projects', teamId],
    queryFn: () => listProjects(teamId!),
    enabled: !!teamId,
  });

  const { data, isLoading } = useQuery({
    queryKey: ['workload-detail', teamId, projectId, window, weighted],
    queryFn: () =>
      fetchWorkloadDetail(teamId!, {
        projectId: projectId || undefined,
        window,
        weighted,
      }),
    enabled: !!teamId,
  });

  const drillParams = useMemo((): WorkloadDrillParams | null => {
    if (!drill) return null;
    const base: WorkloadDrillParams = {
      assigneeId: drill.userId ?? '__unassigned__',
      projectId: projectId || undefined,
    };
    if (drill.kind === 'status') return { ...base, status: drill.status };
    if (drill.kind === 'bucket') return { ...base, dueBucket: drill.bucket as WorkloadDueBucket };
    return base;
  }, [drill, projectId]);

  const { data: drillData, isLoading: drillLoading } = useQuery({
    queryKey: ['workload-drill', teamId, drillParams],
    queryFn: () => fetchWorkloadDrill(teamId!, drillParams!),
    enabled: drill !== null && !!teamId && drillParams !== null,
  });

  const rows = useMemo(() => {
    const items = [...(data?.items ?? [])];
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
  }, [data, sortKey, sortAsc, weighted]);

  const chartData = useMemo(
    () =>
      rows.map((r) => ({
        name: r.name ?? t('workload.unassigned'),
        overdue: r.byDueBucket.overdue,
        this_week: r.byDueBucket.this_week,
        next_week: r.byDueBucket.next_week,
        later: r.byDueBucket.later,
        no_due: r.byDueBucket.no_due,
      })),
    [rows, t],
  );

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortAsc((v) => !v);
    else {
      setSortKey(key);
      setSortAsc(false);
    }
  }

  function openDrill(target: DrillTarget) {
    setDrill(target);
  }

  function drillTitle(): string {
    if (!drill) return '';
    const name = drill.memberName ?? t('workload.unassigned');
    if (drill.kind === 'status') {
      return `${name} — ${t(`workload.status.${drill.status.toLowerCase()}`)}`;
    }
    if (drill.kind === 'bucket') {
      return `${name} — ${t(`workload.bucket.${drill.bucket}`)}`;
    }
    return `${name} — ${t('workload.table.total')}`;
  }

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

      <div className="flex flex-wrap gap-4 items-end bg-surface rounded-lg shadow p-4">
        <label className="text-xs block">
          {t('workload.filter.team')}
          <select
            className="mt-1 block rounded border px-2 py-1.5 text-sm dark:bg-slate-900 min-w-[160px]"
            value={selectedTeamId || currentTeam?.id || ''}
            onChange={(e) => { setSelectedTeamId(e.target.value); setProjectId(''); }}
          >
            {teams.map((tm) => (
              <option key={tm.id} value={tm.id}>
                {tm.name}
              </option>
            ))}
          </select>
        </label>

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

      {!isLoading && rows.length === 0 && (
        <p className="text-sm text-slate-500 italic">{t('workload.empty')}</p>
      )}

      {!isLoading && rows.length > 0 && (
        <>
          <section className="bg-surface rounded-lg shadow p-4">
            <h2 className="text-sm font-semibold mb-4">{t('workload.chartTitle')}</h2>
            <div dir="ltr">
              <ResponsiveContainer width="100%" height={Math.max(280, rows.length * 36)}>
                <BarChart data={chartData} layout="vertical" margin={{ left: 8, right: 16 }}>
                  <XAxis type="number" allowDecimals={false} tick={{ fontSize: 10 }} />
                  <YAxis type="category" dataKey="name" width={120} tick={{ fontSize: 10 }} />
                  <Tooltip />
                  <Legend />
                  {BUCKET_KEYS.map((key) => (
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
                      className={[
                        'border-b border-border',
                        over ? 'bg-danger/10' : '',
                      ].join(' ')}
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
                          onClick={() => openDrill({ kind: 'all', userId: r.userId, memberName: r.name })}
                        >
                          {displayTotal}
                        </button>
                      </td>
                      <td className="p-3 text-end tabular-nums">
                        <button
                          className="hover:underline hover:text-primary"
                          onClick={() => openDrill({ kind: 'bucket', userId: r.userId, memberName: r.name, bucket: 'overdue' })}
                        >
                          {r.byDueBucket.overdue}
                        </button>
                      </td>
                      {BUCKET_KEYS.filter((k) => k !== 'overdue').map((key) => (
                        <td key={key} className="p-3 text-end tabular-nums hidden md:table-cell">
                          <button
                            className="hover:underline hover:text-primary"
                            onClick={() => openDrill({ kind: 'bucket', userId: r.userId, memberName: r.name, bucket: key })}
                          >
                            {r.byDueBucket[key]}
                          </button>
                        </td>
                      ))}
                      {STATUS_KEYS.map((s) => (
                        <td key={s} className="p-3 text-end tabular-nums hidden lg:table-cell">
                          <button
                            className="hover:underline hover:text-primary"
                            onClick={() => openDrill({ kind: 'status', userId: r.userId, memberName: r.name, status: s })}
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
          </section>
        </>
      )}

      {drill && (
        <SlideOver title={drillTitle()} onClose={() => setDrill(null)}>
          <WorkloadTaskList tasks={drillData?.items ?? []} isLoading={drillLoading} />
        </SlideOver>
      )}
    </div>
  );
}

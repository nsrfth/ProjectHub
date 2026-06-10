import { useMemo, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useTeams } from '@/features/teams/TeamsContext';
import * as projectsApi from '@/features/projects/api';
import * as tasksApi from '@/features/tasks/api';
import type { TaskStatus } from '@/features/tasks/api';
import { fetchSummary, fetchWorkload } from '@/features/reports/api';
import { getTeam } from '@/features/teams/api';
import { visibleTeamMembers } from '@/lib/systemUser';
import PlannerChartsPanel from '@/features/planner/charts/PlannerChartsPanel';
import {
  memberBarFromTasks,
  memberBarFromWorkload,
  statusBarFromTasks,
  statusDistributionFromTasks,
} from '@/features/planner/aggregations';
import {
  applyPlannerScopeFilters,
  collectAssigneeOptions,
} from '@/features/planner/PlannerFilterBar';
import type { TaskFilterState } from '@/features/planner/filters';
import { useT } from '@/lib/i18n';

const ALL_TEAMS = 'all' as const;

export default function PlannerChartsPage(): JSX.Element {
  const t = useT();
  const { teams } = useTeams();
  const [teamId, setTeamId] = useState<string | typeof ALL_TEAMS>(ALL_TEAMS);
  const [projectId, setProjectId] = useState<string>('');
  const [scopeFilters, setScopeFilters] = useState<TaskFilterState>({});

  const { data: projects = [] } = useQuery({
    queryKey: ['projects', 'all'],
    queryFn: projectsApi.listAllProjects,
  });

  const filteredProjects = useMemo(() => {
    if (!projectId) return projects;
    return projects.filter((p) => p.id === projectId);
  }, [projects, projectId]);

  const teamScopedProjects = useMemo(() => {
    if (teamId === ALL_TEAMS) return filteredProjects;
    return filteredProjects.filter((p) => p.teamId === teamId);
  }, [filteredProjects, teamId]);

  const taskQueries = useQueries({
    queries: teamScopedProjects.map((p) => ({
      queryKey: ['tasks', p.teamId, p.id],
      queryFn: () => tasksApi.listTasks(p.teamId, p.id),
      enabled: teamScopedProjects.length > 0 && teamScopedProjects.length <= 20,
    })),
  });

  const summaryQueries = useQueries({
    queries:
      teamId === ALL_TEAMS
        ? teams.map((tm) => ({
            queryKey: ['reports', 'summary', tm.id],
            queryFn: () => fetchSummary(tm.id),
          }))
        : [{ queryKey: ['reports', 'summary', teamId], queryFn: () => fetchSummary(teamId) }],
  });

  const workloadQueries = useQueries({
    queries:
      teamId === ALL_TEAMS
        ? teams.map((tm) => ({
            queryKey: ['reports', 'workload', tm.id],
            queryFn: () => fetchWorkload(tm.id),
          }))
        : [{ queryKey: ['reports', 'workload', teamId], queryFn: () => fetchWorkload(teamId) }],
  });

  const memberTeamQuery = useQuery({
    queryKey: ['teams', teamId, 'members'],
    queryFn: () => getTeam(teamId === ALL_TEAMS ? teams[0]!.id : teamId),
    enabled: teamId !== ALL_TEAMS ? !!teamId : teams.length > 0,
  });

  const assigneeNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const mem of visibleTeamMembers(memberTeamQuery.data?.members ?? [])) {
      m.set(mem.userId, mem.name || mem.email);
    }
    return m;
  }, [memberTeamQuery.data]);

  const allTasks = useMemo(() => taskQueries.flatMap((q) => q.data ?? []), [taskQueries]);
  const scopedTasks = useMemo(
    () => applyPlannerScopeFilters(allTasks, scopeFilters),
    [allTasks, scopeFilters],
  );
  const loading = taskQueries.some((q) => q.isLoading);

  const assigneeFilterOptions = useMemo(
    () => collectAssigneeOptions(allTasks, assigneeNames),
    [allTasks, assigneeNames],
  );

  const useTaskAggregation = teamScopedProjects.length > 0 && teamScopedProjects.length <= 20;

  const statusSlices = useMemo(() => {
    if (useTaskAggregation && scopedTasks.length > 0) {
      return statusDistributionFromTasks(scopedTasks);
    }
    if (useTaskAggregation && scopedTasks.length === 0 && allTasks.length > 0) {
      return statusDistributionFromTasks([]);
    }
    const summaries = summaryQueries.map((q) => q.data).filter(Boolean);
    if (summaries.length === 0) return [];
    const merged = { TODO: 0, IN_PROGRESS: 0, REVIEW: 0, DONE: 0 };
    for (const s of summaries) {
      merged.TODO += s!.byStatus.TODO;
      merged.IN_PROGRESS += s!.byStatus.IN_PROGRESS;
      merged.REVIEW += s!.byStatus.REVIEW;
      merged.DONE += s!.byStatus.DONE;
    }
    const total = merged.TODO + merged.IN_PROGRESS + merged.REVIEW + merged.DONE || 1;
    const labels = {
      TODO: 'Open',
      IN_PROGRESS: 'In Progress',
      REVIEW: 'Review',
      DONE: 'Completed',
    };
    return (['TODO', 'IN_PROGRESS', 'REVIEW', 'DONE'] as const).map((s) => ({
      status: s,
      label: labels[s],
      count: merged[s],
      percent: Math.round((merged[s] / total) * 100),
    }));
  }, [useTaskAggregation, scopedTasks, allTasks, summaryQueries]);

  const statusBars = useMemo(
    () =>
      useTaskAggregation
        ? statusBarFromTasks(scopedTasks)
        : statusSlices.map((s) => ({ name: s.label, count: s.count })),
    [useTaskAggregation, scopedTasks, statusSlices],
  );

  const memberBars = useMemo(() => {
    if (useTaskAggregation) {
      return memberBarFromTasks(scopedTasks, assigneeNames);
    }
    const rows = workloadQueries.flatMap((q) => q.data?.items ?? []);
    const filtered = scopeFilters.assigneeId
      ? rows.filter((r) =>
          scopeFilters.assigneeId === '__unassigned__'
            ? !r.assigneeId
            : r.assigneeId === scopeFilters.assigneeId,
        )
      : rows;
    return memberBarFromWorkload(filtered);
  }, [useTaskAggregation, scopedTasks, assigneeNames, workloadQueries, scopeFilters.assigneeId]);

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-4">{t('planner.charts.title')}</h1>
      <div className="flex flex-wrap gap-3 mb-6 text-sm">
        <label className="flex items-center gap-2">
          <span className="text-slate-500">{t('planner.filter.team')}</span>
          <select
            value={teamId}
            onChange={(e) => setTeamId(e.target.value)}
            className="rounded border px-2 py-1 dark:bg-slate-800"
          >
            <option value={ALL_TEAMS}>{t('planner.filter.allTeams')}</option>
            {teams.map((tm) => (
              <option key={tm.id} value={tm.id}>
                {tm.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <span className="text-slate-500">{t('planner.filter.project')}</span>
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="rounded border px-2 py-1 dark:bg-slate-800"
          >
            <option value="">{t('planner.filter.allProjects')}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <span className="text-slate-500">Status</span>
          <select
            value={scopeFilters.status ?? ''}
            onChange={(e) =>
              setScopeFilters((f) => ({
                ...f,
                status: (e.target.value || undefined) as TaskStatus | undefined,
              }))
            }
            className="rounded border px-2 py-1 dark:bg-slate-800"
          >
            <option value="">All</option>
            {(['TODO', 'IN_PROGRESS', 'REVIEW', 'DONE'] as const).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        {assigneeFilterOptions.length > 0 && (
          <label className="flex items-center gap-2">
            <span className="text-slate-500">Member</span>
            <select
              value={scopeFilters.assigneeId ?? ''}
              onChange={(e) =>
                setScopeFilters((f) => ({ ...f, assigneeId: e.target.value || undefined }))
              }
              className="rounded border px-2 py-1 dark:bg-slate-800"
            >
              <option value="">All</option>
              <option value="__unassigned__">Unassigned</option>
              {assigneeFilterOptions.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex items-center gap-2">
          <span className="text-slate-500">Due from</span>
          <input
            type="date"
            value={scopeFilters.dateFrom?.slice(0, 10) ?? ''}
            onChange={(e) =>
              setScopeFilters((f) => ({
                ...f,
                dateFrom: e.target.value ? `${e.target.value}T00:00:00.000Z` : undefined,
              }))
            }
            className="rounded border px-2 py-1 dark:bg-slate-800"
          />
        </label>
        <label className="flex items-center gap-2">
          <span className="text-slate-500">Due to</span>
          <input
            type="date"
            value={scopeFilters.dateTo?.slice(0, 10) ?? ''}
            onChange={(e) =>
              setScopeFilters((f) => ({
                ...f,
                dateTo: e.target.value ? `${e.target.value}T23:59:59.000Z` : undefined,
              }))
            }
            className="rounded border px-2 py-1 dark:bg-slate-800"
          />
        </label>
      </div>
      <PlannerChartsPanel
        statusSlices={statusSlices}
        statusBars={statusBars}
        memberBars={memberBars}
        loading={loading}
        empty={statusSlices.every((s) => s.count === 0)}
      />
    </div>
  );
}

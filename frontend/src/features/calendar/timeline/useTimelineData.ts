import { useMemo } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import * as projectsApi from '@/features/projects/api';
import * as tasksApi from '@/features/tasks/api';
import { getTeam } from '@/features/teams/api';
import type { Team } from '@/features/teams/api';
import { buildTimelineRows, overlapsRange, utcDayMs } from './utils';
import type { TimelineFilters, TimelineRow } from './types';

const ALL_TEAMS = 'all' as const;

interface UseTimelineDataArgs {
  selectedTeam: typeof ALL_TEAMS | string;
  teams: Team[];
  axisStartMs: number;
  axisEndMs: number;
  filters: TimelineFilters;
  collapsedProjects: Set<string>;
  collapsedTasks: Set<string>;
}

export function useTimelineData({
  selectedTeam,
  teams,
  axisStartMs,
  axisEndMs,
  filters,
  collapsedProjects,
  collapsedTasks,
}: UseTimelineDataArgs) {
  const isAllTeams = selectedTeam === ALL_TEAMS;

  const { data: allProjects = [], isLoading: projectsLoading } = useQuery({
    queryKey: ['projects', 'all'],
    queryFn: projectsApi.listAllProjects,
  });

  const scopedProjects = useMemo(() => {
    if (isAllTeams) return allProjects;
    return allProjects.filter((p) => p.teamId === selectedTeam);
  }, [allProjects, isAllTeams, selectedTeam]);

  const filteredByProject = useMemo(() => {
    if (!filters.projectId) return scopedProjects;
    return scopedProjects.filter((p) => p.id === filters.projectId);
  }, [scopedProjects, filters.projectId]);

  const taskQueries = useQueries({
    queries: filteredByProject.map((p) => ({
      queryKey: ['tasks', p.teamId, p.id],
      queryFn: () => tasksApi.listTasks(p.teamId, p.id),
      enabled: filteredByProject.length > 0,
    })),
  });

  const teamIds = useMemo(
    () => [...new Set(filteredByProject.map((p) => p.teamId))],
    [filteredByProject],
  );

  const teamQueries = useQueries({
    queries: teamIds.map((id) => ({
      queryKey: ['teams', id],
      queryFn: () => getTeam(id),
      enabled: teamIds.length > 0,
    })),
  });

  const assigneeNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const q of teamQueries) {
      for (const mem of q.data?.members ?? []) {
        m.set(mem.userId, mem.name || mem.email);
      }
    }
    return m;
  }, [teamQueries]);

  const teamColors = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of teams) {
      m.set(t.id, t.color ?? '#64748b');
    }
    return m;
  }, [teams]);

  const tasksByProject = useMemo(() => {
    const m = new Map<string, tasksApi.Task[]>();
    filteredByProject.forEach((p, i) => {
      const data = taskQueries[i]?.data;
      if (data) m.set(p.id, data);
    });
    return m;
  }, [filteredByProject, taskQueries]);

  const allRows = useMemo(() => {
    const rows = buildTimelineRows({
      projects: filteredByProject,
      tasksByProject,
      teamColors,
      collapsedProjects,
      collapsedTasks,
    });
    return rows.map((r) => {
      if (r.kind === 'task' && r.taskId) {
        const task = tasksByProject.get(r.projectId)?.find((t) => t.id === r.taskId);
        const name = task?.assigneeId ? assigneeNames.get(task.assigneeId) ?? null : null;
        return { ...r, assigneeName: name };
      }
      return r;
    });
  }, [
    filteredByProject,
    tasksByProject,
    teamColors,
    collapsedProjects,
    collapsedTasks,
    assigneeNames,
  ]);

  const filteredRows = useMemo(() => {
    const q = filters.search.trim().toLowerCase();
    const filtered = allRows.filter((row) => {
      if (row.kind === 'project') return true;

      if (filters.status && row.status !== filters.status) return false;
      if (filters.assigneeId) {
        const tasks = tasksByProject.get(row.projectId) ?? [];
        if (row.kind === 'task' && row.taskId) {
          const task = tasks.find((t) => t.id === row.taskId);
          if (task?.assigneeId !== filters.assigneeId) return false;
        } else if (row.kind === 'subtask') {
          const task = tasks.find((t) => t.id === row.taskId);
          const sub = task?.subtasks.find((s) => s.id === row.subtaskId);
          if (sub?.assigneeId !== filters.assigneeId) return false;
        }
      }

      if (filters.dateFrom && row.barEnd) {
        if (utcDayMs(row.barEnd) < utcDayMs(filters.dateFrom)) return false;
      }
      if (filters.dateTo && row.barStart) {
        if (utcDayMs(row.barStart) > utcDayMs(filters.dateTo)) return false;
      }

      if (q) {
        const hay = `${row.label} ${row.projectName}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }

      if (row.kind !== 'project' && row.barStart && row.barEnd) {
        if (!overlapsRange(row.barStart, row.barEnd, axisStartMs, axisEndMs)) return false;
      }

      return true;
    });

    const pruned: TimelineRow[] = [];
    for (let i = 0; i < filtered.length; i++) {
      const row = filtered[i]!;
      if (row.kind !== 'project') {
        pruned.push(row);
        continue;
      }
      const hasChild = filtered.slice(i + 1).some((r) => r.kind !== 'project' && r.projectId === row.projectId);
      if (hasChild) pruned.push(row);
    }
    return pruned;
  }, [allRows, filters, tasksByProject, axisStartMs, axisEndMs]);

  const filterOptions = useMemo(() => {
    const projectOpts = scopedProjects.map((p) => ({ id: p.id, name: p.name }));
    const assigneeSet = new Map<string, string>();
    const statusSet = new Set<string>();
    for (const tasks of tasksByProject.values()) {
      for (const t of tasks) {
        statusSet.add(t.status);
        if (t.assigneeId) {
          assigneeSet.set(t.assigneeId, assigneeNames.get(t.assigneeId) ?? t.assigneeId);
        }
        for (const s of t.subtasks) {
          if (s.assigneeId) {
            assigneeSet.set(s.assigneeId, s.assigneeName ?? s.assigneeId);
          }
        }
      }
    }
    return {
      projects: projectOpts,
      assignees: [...assigneeSet.entries()].map(([id, name]) => ({ id, name })),
      statuses: [...statusSet],
    };
  }, [scopedProjects, tasksByProject, assigneeNames]);

  const isFetching =
    projectsLoading || taskQueries.some((q) => q.isFetching) || teamQueries.some((q) => q.isFetching);

  return {
    rows: filteredRows as TimelineRow[],
    filterOptions,
    isFetching,
    tasksByProject,
  };
}

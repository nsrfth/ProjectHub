import type { ProjectCrossTeam, ProjectStatus } from '@/features/projects/api';

export interface ProjectFilterState {
  search?: string;
  status?: ProjectStatus | '';
  teamId?: string;
  owner?: 'all' | 'mine';
  dateFrom?: string;
  dateTo?: string;
}

export function applyProjectFilters(
  projects: ProjectCrossTeam[],
  filters: ProjectFilterState,
  userId?: string,
  bucketNamesByProject?: Map<string, string[]>,
): ProjectCrossTeam[] {
  let out = projects;
  if (filters.status) {
    out = out.filter((p) => p.status === filters.status);
  }
  if (filters.teamId) {
    out = out.filter((p) => p.teamId === filters.teamId);
  }
  if (filters.owner === 'mine' && userId) {
    out = out.filter((p) => p.ownerId === userId);
  }
  if (filters.dateFrom) {
    const from = new Date(filters.dateFrom).getTime();
    out = out.filter((p) => new Date(p.createdAt).getTime() >= from);
  }
  if (filters.dateTo) {
    const to = new Date(filters.dateTo).getTime();
    out = out.filter((p) => new Date(p.createdAt).getTime() <= to);
  }
  if (filters.search?.trim()) {
    const q = filters.search.trim().toLowerCase();
    out = out.filter((p) => {
      if (p.name.toLowerCase().includes(q)) return true;
      if (p.description?.toLowerCase().includes(q)) return true;
      const buckets = bucketNamesByProject?.get(p.id) ?? [];
      return buckets.some((n) => n.toLowerCase().includes(q));
    });
  }
  return out;
}

export function collectTeamOptions(projects: ProjectCrossTeam[]): { id: string; name: string }[] {
  const m = new Map<string, string>();
  for (const p of projects) m.set(p.teamId, p.teamName);
  return [...m.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

export function projectIdsInAnyBucket(buckets: { projectIds: string[] }[]): Set<string> {
  const s = new Set<string>();
  for (const b of buckets) for (const id of b.projectIds) s.add(id);
  return s;
}

/** Future metrics hook — planned budget totals per bucket without refactoring UI. */
export function bucketBudgetSummary(
  projectIds: string[],
  projectsById: Map<string, ProjectCrossTeam>,
): { planned: number; count: number } {
  let planned = 0;
  for (const id of projectIds) {
    const p = projectsById.get(id);
    if (!p) continue;
    if (p.plannedBudget) planned += Number(p.plannedBudget);
  }
  return { planned, count: projectIds.length };
}

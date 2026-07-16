const COLLAPSED_KEY = 'projects.buckets.collapsed';
const VIEW_KEY = 'projects.viewMode';
// v2.5.58: remember the team filter across navigations/reloads, mirroring the
// calendar.selectedTeam / reports.selectedTeam pattern. undefined = all teams.
const SELECTED_TEAM_KEY = 'projects.selectedTeam';

export type ProjectsViewMode = 'all' | 'buckets';

export function loadProjectsViewMode(): ProjectsViewMode {
  if (typeof window === 'undefined') return 'all';
  const v = window.localStorage.getItem(VIEW_KEY);
  return v === 'buckets' ? 'buckets' : 'all';
}

export function saveProjectsViewMode(mode: ProjectsViewMode): void {
  if (typeof window !== 'undefined') window.localStorage.setItem(VIEW_KEY, mode);
}

export function loadProjectsSelectedTeam(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.localStorage.getItem(SELECTED_TEAM_KEY) ?? undefined;
}

export function saveProjectsSelectedTeam(teamId: string | undefined): void {
  if (typeof window === 'undefined') return;
  try {
    if (teamId) window.localStorage.setItem(SELECTED_TEAM_KEY, teamId);
    else window.localStorage.removeItem(SELECTED_TEAM_KEY);
  } catch {
    // Private-mode Safari can throw on write; the filter simply won't persist.
  }
}

export function loadCollapsedBuckets(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(COLLAPSED_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

export function saveCollapsedBuckets(ids: Set<string>): void {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...ids]));
  }
}

export const BUCKET_COLORS = [
  '#6366f1',
  '#8b5cf6',
  '#ec4899',
  '#f59e0b',
  '#10b981',
  '#06b6d4',
  '#64748b',
  '#ef4444',
] as const;

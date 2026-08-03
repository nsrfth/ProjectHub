import type { ProjectCrossTeam, ProjectStatus, RagStatus } from './api';

export interface ProjectsDashboardSummary {
  total: number;
  active: number;
  atRisk: number;
  averageProgress: number;
  overdue: number;
  endingSoon: number;
  byStatus: Record<ProjectStatus, number>;
  byHealth: Record<RagStatus, number>;
}

const DAY_MS = 86_400_000;

export function projectProgress(project: ProjectCrossTeam): number {
  return Math.max(0, Math.min(100, Math.round(project.progressPct ?? 0)));
}

export function summarizeProjects(
  projects: ProjectCrossTeam[],
  now = new Date(),
): ProjectsDashboardSummary {
  const byStatus: Record<ProjectStatus, number> = {
    ACTIVE: 0,
    ON_HOLD: 0,
    ARCHIVED: 0,
  };
  const byHealth: Record<RagStatus, number> = {
    GREEN: 0,
    AMBER: 0,
    RED: 0,
  };

  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();
  const soonMs = todayMs + 30 * DAY_MS;
  let totalProgress = 0;
  let overdue = 0;
  let endingSoon = 0;

  for (const project of projects) {
    byStatus[project.status] += 1;
    byHealth[project.ragStatus ?? 'GREEN'] += 1;
    const progress = projectProgress(project);
    totalProgress += progress;

    if (project.status === 'ARCHIVED' || !project.endDate || progress >= 100) continue;
    const endMs = new Date(project.endDate).getTime();
    if (endMs < todayMs) overdue += 1;
    else if (endMs <= soonMs) endingSoon += 1;
  }

  return {
    total: projects.length,
    active: byStatus.ACTIVE,
    atRisk: byHealth.AMBER + byHealth.RED,
    averageProgress: projects.length ? Math.round(totalProgress / projects.length) : 0,
    overdue,
    endingSoon,
    byStatus,
    byHealth,
  };
}

const HEALTH_WEIGHT: Record<RagStatus, number> = { RED: 0, AMBER: 1, GREEN: 2 };

export function sortProjectsForDashboard(
  projects: ProjectCrossTeam[],
): ProjectCrossTeam[] {
  return [...projects].sort((a, b) => {
    const healthDelta =
      HEALTH_WEIGHT[a.ragStatus ?? 'GREEN'] - HEALTH_WEIGHT[b.ragStatus ?? 'GREEN'];
    if (healthDelta !== 0) return healthDelta;

    if (a.endDate && b.endDate) {
      const dateDelta = a.endDate.localeCompare(b.endDate);
      if (dateDelta !== 0) return dateDelta;
    } else if (a.endDate) return -1;
    else if (b.endDate) return 1;

    return a.name.localeCompare(b.name);
  });
}

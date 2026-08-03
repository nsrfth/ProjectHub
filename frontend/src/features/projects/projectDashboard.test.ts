import { describe, expect, it } from 'vitest';
import type { ProjectCrossTeam } from './api';
import {
  projectProgress,
  sortProjectsForDashboard,
  summarizeProjects,
} from './projectDashboard';

function project(
  id: string,
  patch: Partial<ProjectCrossTeam> = {},
): ProjectCrossTeam {
  return {
    id,
    teamId: 'team-1',
    teamName: 'Delivery',
    teamSlug: 'delivery',
    department: null,
    ownerId: 'user-1',
    accountableId: null,
    accountableName: null,
    name: id,
    code: null,
    description: null,
    status: 'ACTIVE',
    ragStatus: 'GREEN',
    ragReason: null,
    healthUpdatedAt: null,
    plannedBudget: null,
    budgetCurrency: 'USD',
    startDate: null,
    endDate: null,
    labels: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}

describe('projects dashboard summary', () => {
  it('rolls up health, status, progress, and schedule signals', () => {
    const rows = [
      project('late', { ragStatus: 'RED', progressPct: 25, endDate: '2026-07-31T00:00:00.000Z' }),
      project('soon', { ragStatus: 'AMBER', progressPct: 75, endDate: '2026-08-20T00:00:00.000Z' }),
      project('done', { status: 'ARCHIVED', progressPct: 100, endDate: '2026-01-01T00:00:00.000Z' }),
      project('hold', { status: 'ON_HOLD' }),
    ];

    expect(summarizeProjects(rows, new Date('2026-08-03T12:00:00.000Z'))).toEqual({
      total: 4,
      active: 2,
      atRisk: 2,
      averageProgress: 50,
      overdue: 1,
      endingSoon: 1,
      byStatus: { ACTIVE: 2, ON_HOLD: 1, ARCHIVED: 1 },
      byHealth: { GREEN: 2, AMBER: 1, RED: 1 },
    });
  });

  it('clamps progress and puts unhealthy, time-sensitive projects first', () => {
    const rows = [
      project('green', { progressPct: 140 }),
      project('amber-later', { ragStatus: 'AMBER', endDate: '2026-10-01T00:00:00.000Z' }),
      project('red', { ragStatus: 'RED' }),
      project('amber-sooner', { ragStatus: 'AMBER', endDate: '2026-09-01T00:00:00.000Z' }),
    ];

    expect(projectProgress(rows[0])).toBe(100);
    expect(sortProjectsForDashboard(rows).map((row) => row.id)).toEqual([
      'red',
      'amber-sooner',
      'amber-later',
      'green',
    ]);
  });
});

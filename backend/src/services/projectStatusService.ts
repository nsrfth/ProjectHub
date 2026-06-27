import type { Currency, ProjectStatus, RagStatus } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';
import { ProfilesService } from './profilesService.js';

export interface ProjectStatusReport {
  projectId: string;
  name: string;
  code: string | null;
  description: string | null;
  status: ProjectStatus;
  ragStatus: RagStatus;
  ragReason: string | null;
  healthUpdatedAt: string | null;
  startDate: string | null;
  endDate: string | null;
  ownerName: string | null;
  accountableName: string | null;
  plannedBudget: string | null;
  budgetCurrency: Currency;
  taskCounts: {
    todo: number;
    inProgress: number;
    review: number;
    done: number;
    total: number;
  };
  overdueCount: number;
  percentComplete: number;
  risks: { open: number; total: number } | null;
  changeRequests: { pending: number; approved: number; total: number } | null;
  costSummary: { plannedBudgetLines: string; committed: string; actual: string; currency: string } | null;
}

export class ProjectStatusService {
  async forProject(teamId: string, projectId: string): Promise<ProjectStatusReport> {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        teamId: true,
        name: true,
        code: true,
        description: true,
        status: true,
        ragStatus: true,
        ragReason: true,
        healthUpdatedAt: true,
        startDate: true,
        endDate: true,
        plannedBudget: true,
        budgetCurrency: true,
        owner: { select: { name: true } },
        accountable: { select: { name: true } },
      },
    });
    if (!project || project.teamId !== teamId) throw Errors.notFound('Project not found');

    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    // Resolve which modules are enabled for this project.
    const profileSvc = new ProfilesService();
    const effectiveCfg = await profileSvc.getEffectiveConfig(teamId, projectId);
    const mods = effectiveCfg.modules;

    const riskEnabled = mods.risk?.enabled ?? false;
    const changeEnabled = mods.change_control?.enabled ?? false;
    const costEnabled = mods.cost_control?.enabled ?? false;

    const [statusCounts, overdueCount, riskOpenCnt, riskTotalCnt, crCounts, budgetAgg, commitAgg, actualAgg] = await Promise.all([
      prisma.task.groupBy({
        by: ['status'],
        where: { projectId, deletedAt: null },
        _count: { _all: true },
      }),
      prisma.task.count({
        where: { projectId, deletedAt: null, status: { not: 'DONE' }, dueDate: { lt: todayStart } },
      }),
      // RiskRecord has no status field — closedAt: null means open
      riskEnabled ? prisma.riskRecord.count({ where: { projectId, closedAt: null } }) : Promise.resolve(null),
      riskEnabled ? prisma.riskRecord.count({ where: { projectId } }) : Promise.resolve(null),
      changeEnabled
        ? prisma.changeRequest.groupBy({ by: ['status'], where: { projectId }, _count: { _all: true } })
        : Promise.resolve(null),
      costEnabled
        ? prisma.budgetLine.aggregate({ where: { projectId }, _sum: { amountMinor: true } })
        : Promise.resolve(null),
      costEnabled
        ? prisma.commitment.aggregate({ where: { projectId, status: 'OPEN' }, _sum: { amountMinor: true } })
        : Promise.resolve(null),
      costEnabled
        ? prisma.actualCostEntry.aggregate({ where: { projectId }, _sum: { amountMinor: true } })
        : Promise.resolve(null),
    ]);

    const byStatus = { TODO: 0, IN_PROGRESS: 0, REVIEW: 0, DONE: 0 };
    for (const c of statusCounts) {
      byStatus[c.status as keyof typeof byStatus] = c._count._all;
    }
    const total = byStatus.TODO + byStatus.IN_PROGRESS + byStatus.REVIEW + byStatus.DONE;
    const percentComplete = total > 0 ? Math.round((byStatus.DONE / total) * 100) : 0;

    // Risk summary
    let risks: ProjectStatusReport['risks'] = null;
    if (riskOpenCnt !== null && riskTotalCnt !== null) {
      risks = { open: riskOpenCnt, total: riskTotalCnt };
    }

    // Change request summary — pending = SUBMITTED; no UNDER_REVIEW status exists
    let changeRequests: ProjectStatusReport['changeRequests'] = null;
    if (crCounts) {
      const crTotal = crCounts.reduce((s, r) => s + r._count._all, 0);
      const pending = crCounts
        .filter((r) => r.status === 'SUBMITTED')
        .reduce((s, r) => s + r._count._all, 0);
      const approved = crCounts
        .filter((r) => r.status === 'APPROVED')
        .reduce((s, r) => s + r._count._all, 0);
      changeRequests = { pending, approved, total: crTotal };
    }

    // Cost summary — BigInt minor units → display string (÷100, 2 d.p.)
    let costSummary: ProjectStatusReport['costSummary'] = null;
    if (budgetAgg !== null) {
      const toMajor = (v: bigint | null) => ((v ?? 0n) / 100n).toString() + '.' +
        String(Number((v ?? 0n) % 100n)).padStart(2, '0');
      costSummary = {
        plannedBudgetLines: toMajor(budgetAgg._sum.amountMinor),
        committed: toMajor(commitAgg?._sum.amountMinor ?? null),
        actual: toMajor(actualAgg?._sum.amountMinor ?? null),
        currency: project.budgetCurrency,
      };
    }

    return {
      projectId: project.id,
      name: project.name,
      code: project.code ?? null,
      description: project.description ?? null,
      status: project.status,
      ragStatus: project.ragStatus,
      ragReason: project.ragReason ?? null,
      healthUpdatedAt: project.healthUpdatedAt ? project.healthUpdatedAt.toISOString() : null,
      startDate: project.startDate ? project.startDate.toISOString() : null,
      endDate: project.endDate ? project.endDate.toISOString() : null,
      ownerName: project.owner?.name ?? null,
      accountableName: project.accountable?.name ?? null,
      plannedBudget: project.plannedBudget === null ? null : project.plannedBudget.toFixed(2),
      budgetCurrency: project.budgetCurrency,
      taskCounts: {
        todo: byStatus.TODO,
        inProgress: byStatus.IN_PROGRESS,
        review: byStatus.REVIEW,
        done: byStatus.DONE,
        total,
      },
      overdueCount,
      percentComplete,
      risks,
      changeRequests,
      costSummary,
    };
  }
}

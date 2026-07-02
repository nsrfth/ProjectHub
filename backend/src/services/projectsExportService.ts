import ExcelJS from 'exceljs';
import type { GlobalRole } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { resolveProjectAccess } from '../lib/projectAccess.js';
import { ProfilesService } from './profilesService.js';
import { EvmService } from './evmService.js';
import { ResourceService } from './resourceService.js';

export const EXPORT_CAP = 200;

const profiles = new ProfilesService();
const evm = new EvmService();
const resources = new ResourceService();

function isoToDate(s: string | Date | null | undefined): Date | null {
  if (!s) return null;
  return s instanceof Date ? s : new Date(s);
}

function bigintToNum(n: bigint | null | undefined): number | null {
  if (n == null) return null;
  return Number(n);
}

function dateCell(ws: ExcelJS.Worksheet, row: ExcelJS.Row, col: number, d: Date | null) {
  if (!d) return;
  const cell = row.getCell(col);
  cell.value = d;
  cell.numFmt = 'yyyy-mm-dd';
}

type SheetMap = {
  projects: ExcelJS.Worksheet;
  tasks: ExcelJS.Worksheet;
  subtasks: ExcelJS.Worksheet;
  cost_accounts: ExcelJS.Worksheet;
  budget_lines: ExcelJS.Worksheet;
  commitments: ExcelJS.Worksheet;
  expenses: ExcelJS.Worksheet;
  actual_costs: ExcelJS.Worksheet;
  time_entries: ExcelJS.Worksheet;
  resource_assignments: ExcelJS.Worksheet;
  evm: ExcelJS.Worksheet;
  risks: ExcelJS.Worksheet;
  change_requests: ExcelJS.Worksheet;
  contracts: ExcelJS.Worksheet;
  purchase_orders: ExcelJS.Worksheet;
  quality_ncrs: ExcelJS.Worksheet;
  baselines: ExcelJS.Worksheet;
};

function setupSheets(wb: ExcelJS.Workbook): SheetMap {
  function addSheet(name: string, headers: string[]): ExcelJS.Worksheet {
    const ws = wb.addWorksheet(name);
    ws.addRow(headers).font = { bold: true };
    return ws;
  }

  return {
    projects: addSheet('projects', [
      'project_id', 'project_name', 'project_code', 'team_id', 'team_name', 'team_slug',
      'status', 'rag_status', 'rag_reason', 'owner_id', 'accountable_id', 'accountable_name',
      'description', 'planned_budget', 'budget_currency',
      'start_date', 'end_date', 'created_at', 'updated_at',
    ]),
    tasks: addSheet('tasks', [
      'project_id', 'task_id', 'title', 'status', 'priority',
      'responsible_id', 'responsible_name', 'assignee_id', 'assignee_name',
      'start_date', 'due_date', 'planned_date', 'completed_at',
      'baseline_start', 'baseline_end', 'actual_start', 'actual_end',
      'percent_complete', 'is_milestone', 'parent_id', 'wbs_depth',
      'planned_budget', 'actual_spent', 'budget_currency', 'created_at',
    ]),
    subtasks: addSheet('subtasks', [
      'project_id', 'task_id', 'subtask_id', 'title', 'status', 'done',
      'responsible_id', 'responsible_name', 'assignee_id', 'assignee_name',
      'start_date', 'end_date', 'position',
    ]),
    cost_accounts: addSheet('cost_accounts', [
      'project_id', 'id', 'parent_id', 'code', 'name', 'path', 'is_default', 'created_at',
    ]),
    budget_lines: addSheet('budget_lines', [
      'project_id', 'id', 'cost_account_id', 'task_id',
      'amount_minor', 'currency', 'source', 'note', 'created_at',
    ]),
    commitments: addSheet('commitments', [
      'project_id', 'id', 'cost_account_id', 'vendor_name', 'reference',
      'amount_minor', 'currency', 'status', 'incurred_on', 'created_at',
    ]),
    expenses: addSheet('expenses', [
      'project_id', 'id', 'cost_account_id', 'task_id',
      'amount_minor', 'currency', 'status', 'description', 'incurred_on', 'created_at',
    ]),
    actual_costs: addSheet('actual_costs', [
      'project_id', 'id', 'cost_account_id', 'task_id', 'source',
      'amount_minor', 'currency', 'base_amount_minor', 'base_currency',
      'incurred_on', 'description', 'reversal_of_id', 'created_at',
    ]),
    time_entries: addSheet('time_entries', [
      'project_id', 'id', 'user_id', 'task_id', 'period_id',
      'date', 'minutes', 'billable', 'note', 'created_at',
    ]),
    resource_assignments: addSheet('resource_assignments', [
      'project_id', 'task_id', 'id', 'resource_id', 'resource_name', 'resource_type',
      'units', 'planned_hours', 'actual_hours', 'created_at',
    ]),
    evm: addSheet('evm', [
      'project_id', 'as_of', 'bac', 'pv', 'ev', 'ac',
      'cv', 'sv', 'cpi', 'spi', 'eac', 'eac_method', 'vac', 'tcpi', 'currency',
    ]),
    risks: addSheet('risks', [
      'project_id', 'id', 'reference', 'title', 'description',
      'probability', 'impact', 'score', 'response', 'mitigation_plan',
      'owner_id', 'due_date', 'closed_at', 'created_at',
    ]),
    change_requests: addSheet('change_requests', [
      'project_id', 'id', 'reference', 'title', 'description', 'status',
      'schedule_delta_days', 'cost_impact_minor', 'cost_currency',
      'submitted_at', 'decided_at', 'created_at',
    ]),
    contracts: addSheet('contracts', [
      'project_id', 'id', 'vendor_id', 'reference', 'title', 'status',
      'value_minor', 'currency', 'start_date', 'end_date', 'notes', 'created_at',
    ]),
    purchase_orders: addSheet('purchase_orders', [
      'project_id', 'id', 'contract_id', 'reference', 'title', 'status',
      'amount_minor', 'currency', 'issued_date', 'expected_date', 'received_date', 'created_at',
    ]),
    quality_ncrs: addSheet('quality_ncrs', [
      'project_id', 'id', 'reference', 'title', 'description',
      'severity', 'disposition', 'closed_at', 'created_at',
    ]),
    baselines: addSheet('baselines', [
      'project_id', 'id', 'name', 'source', 'is_current',
      'captured_by_id', 'captured_at', 'entry_count',
    ]),
  };
}

export class ProjectsExportService {
  async buildWorkbook(
    teamId: string,
    callerUserId: string,
    callerGlobalRole: GlobalRole,
    projectIds: string[],
  ): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'ProjectHub';
    wb.created = new Date();

    const sh = setupSheets(wb);

    for (const projectId of projectIds) {
      const level = await resolveProjectAccess(projectId, teamId, callerUserId, callerGlobalRole);
      if (level === 'NONE') continue;

      const project = await prisma.project.findUnique({
        where: { id: projectId },
        include: {
          team: { select: { name: true, slug: true } },
          accountable: { select: { name: true } },
        },
      });
      if (!project || project.teamId !== teamId) continue;

      // ── Projects sheet ────────────────────────────────────────────────────
      {
        const r = sh.projects.addRow([
          project.id,
          project.name,
          project.code ?? null,
          project.teamId,
          project.team.name,
          project.team.slug,
          project.status,
          project.ragStatus,
          project.ragReason ?? null,
          project.ownerId,
          project.accountableId ?? null,
          project.accountable?.name ?? null,
          project.description ?? null,
          project.plannedBudget !== null ? project.plannedBudget.toString() : null,
          project.budgetCurrency,
          null, // start_date placeholder
          null, // end_date placeholder
          null, // created_at placeholder
          null, // updated_at placeholder
        ]);
        dateCell(sh.projects, r, 16, isoToDate(project.startDate));
        dateCell(sh.projects, r, 17, isoToDate(project.endDate));
        dateCell(sh.projects, r, 18, project.createdAt);
        dateCell(sh.projects, r, 19, project.updatedAt);
      }

      // ── Module gates ──────────────────────────────────────────────────────
      // Resolve the effective profile config once; reading each flag off it
      // avoids recomputing (and re-querying) the same config nine times.
      const cfg = await profiles.getEffectiveConfig(teamId, projectId);
      const hasCost = cfg.modules.cost_control?.enabled ?? false;
      const hasTimesheets = cfg.modules.timesheets?.enabled ?? false;
      const hasResources = cfg.modules.resource_mgmt?.enabled ?? false;
      const hasEvm = cfg.modules.evm?.enabled ?? false;
      const hasRisk = cfg.modules.risk?.enabled ?? false;
      const hasChangeControl = cfg.modules.change_control?.enabled ?? false;
      const hasProcurement = cfg.modules.procurement?.enabled ?? false;
      const hasQuality = cfg.modules.quality?.enabled ?? false;
      const hasBaselines = cfg.modules.baselines?.enabled ?? false;

      // ── Tasks + Subtasks ──────────────────────────────────────────────────
      // budgetCurrency lives on the project, not the task; include relations for names.
      const tasks = await prisma.task.findMany({
        where: { teamId, projectId, deletedAt: null },
        include: {
          responsible: { select: { name: true } },
          assignee: { select: { name: true } },
        },
        orderBy: [{ status: 'asc' }, { position: 'asc' }],
      });

      for (const t of tasks) {
        const r = sh.tasks.addRow([
          projectId,
          t.id,
          t.title,
          t.status,
          t.priority,
          t.responsibleId ?? null,
          t.responsible?.name ?? null,
          t.assigneeId ?? null,
          t.assignee?.name ?? null,
          null, null, null, null, null, null, null, null, // date placeholders cols 10-17
          t.percentComplete,
          t.isMilestone,
          t.parentId ?? null,
          t.wbsDepth,
          t.plannedBudget !== null ? t.plannedBudget.toString() : null,
          t.actualSpent !== null ? t.actualSpent.toString() : null,
          project.budgetCurrency, // tasks inherit currency from project
          null, // created_at placeholder col 25
        ]);
        dateCell(sh.tasks, r, 10, t.startDate);
        dateCell(sh.tasks, r, 11, t.dueDate);
        dateCell(sh.tasks, r, 12, t.plannedDate);
        dateCell(sh.tasks, r, 13, t.completedAt);
        dateCell(sh.tasks, r, 14, t.baselineStart);
        dateCell(sh.tasks, r, 15, t.baselineEnd);
        dateCell(sh.tasks, r, 16, t.actualStart);
        dateCell(sh.tasks, r, 17, t.actualEnd);
        dateCell(sh.tasks, r, 25, t.createdAt); // col 25 = created_at
      }

      const subtasks = await prisma.subtask.findMany({
        where: { task: { teamId, projectId, deletedAt: null } },
        select: {
          id: true, taskId: true, title: true, status: true, done: true,
          responsibleId: true, responsible: { select: { name: true } },
          assigneeId: true, assignee: { select: { name: true } },
          startDate: true, endDate: true, position: true,
        },
        orderBy: [{ taskId: 'asc' }, { position: 'asc' }],
      });

      for (const s of subtasks) {
        const r = sh.subtasks.addRow([
          projectId,
          s.taskId,
          s.id,
          s.title,
          s.status,
          s.done,
          s.responsibleId ?? null,
          s.responsible?.name ?? null,
          s.assigneeId ?? null,
          s.assignee?.name ?? null,
          null, null, // date placeholders
          s.position,
        ]);
        dateCell(sh.subtasks, r, 11, isoToDate(s.startDate));
        dateCell(sh.subtasks, r, 12, isoToDate(s.endDate));
      }

      // ── Cost sheets ───────────────────────────────────────────────────────
      if (hasCost) {
        const accounts = await prisma.costAccount.findMany({
          where: { teamId, projectId },
          orderBy: { path: 'asc' },
        });
        for (const a of accounts) {
          const r = sh.cost_accounts.addRow([
            projectId, a.id, a.parentId ?? null,
            a.code, a.name, a.path, a.isDefault,
            null,
          ]);
          dateCell(sh.cost_accounts, r, 8, a.createdAt);
        }

        const lines = await prisma.budgetLine.findMany({
          where: { teamId, projectId },
          orderBy: { createdAt: 'asc' },
        });
        for (const l of lines) {
          const r = sh.budget_lines.addRow([
            projectId, l.id, l.costAccountId, l.taskId ?? null,
            bigintToNum(l.amountMinor), l.currency, l.source, l.note ?? null,
            null,
          ]);
          dateCell(sh.budget_lines, r, 9, l.createdAt);
        }

        const commits = await prisma.commitment.findMany({
          where: { teamId, projectId },
          orderBy: { createdAt: 'asc' },
        });
        for (const c of commits) {
          const r = sh.commitments.addRow([
            projectId, c.id, c.costAccountId ?? null,
            c.vendorName ?? null, c.reference ?? null,
            bigintToNum(c.amountMinor), c.currency, c.status,
            null, null,
          ]);
          dateCell(sh.commitments, r, 9, c.incurredOn);
          dateCell(sh.commitments, r, 10, c.createdAt);
        }

        const expenses = await prisma.expense.findMany({
          where: { teamId, projectId },
          orderBy: { createdAt: 'asc' },
        });
        for (const e of expenses) {
          const r = sh.expenses.addRow([
            projectId, e.id, e.costAccountId ?? null, e.taskId ?? null,
            bigintToNum(e.amountMinor), e.currency, e.status,
            e.description ?? null,
            null, null,
          ]);
          dateCell(sh.expenses, r, 9, e.incurredOn);
          dateCell(sh.expenses, r, 10, e.createdAt);
        }

        const actuals = await prisma.actualCostEntry.findMany({
          where: { teamId, projectId },
          orderBy: { incurredOn: 'asc' },
        });
        for (const a of actuals) {
          const r = sh.actual_costs.addRow([
            projectId, a.id, a.costAccountId ?? null, a.taskId ?? null, a.source,
            bigintToNum(a.amountMinor), a.currency,
            bigintToNum(a.baseAmountMinor), a.baseCurrency,
            null,
            a.description ?? null, a.reversalOfId ?? null,
            null,
          ]);
          dateCell(sh.actual_costs, r, 10, a.incurredOn);
          dateCell(sh.actual_costs, r, 13, a.createdAt);
        }
      }

      // ── Time entries ──────────────────────────────────────────────────────
      if (hasTimesheets) {
        const entries = await prisma.timeEntry.findMany({
          where: { teamId, projectId },
          orderBy: { date: 'asc' },
        });
        for (const e of entries) {
          const r = sh.time_entries.addRow([
            projectId, e.id, e.userId, e.taskId ?? null, e.periodId ?? null,
            null,
            e.minutes, e.billable, e.note ?? null,
            null,
          ]);
          dateCell(sh.time_entries, r, 6, e.date);
          dateCell(sh.time_entries, r, 10, e.createdAt);
        }
      }

      // ── Resource assignments ──────────────────────────────────────────────
      if (hasResources) {
        const assignments = await resources.listAssignmentsForProject(teamId, projectId);
        for (const a of assignments) {
          const r = sh.resource_assignments.addRow([
            projectId, a.taskId, a.id, a.resourceId,
            a.resourceName, a.resourceType,
            a.units, a.plannedHours ?? null, a.actualHours ?? null,
            null,
          ]);
          dateCell(sh.resource_assignments, r, 10, new Date(a.createdAt));
        }
      }

      // ── EVM ───────────────────────────────────────────────────────────────
      if (hasEvm) {
        try {
          const metrics = await evm.computeEvm(teamId, projectId, {});
          const r = sh.evm.addRow([
            projectId, null,
            metrics.bac, metrics.pv, metrics.ev, metrics.ac,
            metrics.cv, metrics.sv, metrics.cpi, metrics.spi,
            metrics.eac, metrics.eacMethod, metrics.vac, metrics.tcpi,
            metrics.currency,
          ]);
          dateCell(sh.evm, r, 2, new Date(metrics.asOf));
        } catch {
          // No baseline set — skip EVM row for this project.
        }
      }

      // ── Risks ─────────────────────────────────────────────────────────────
      if (hasRisk) {
        const risks = await prisma.riskRecord.findMany({
          where: { teamId, projectId },
          orderBy: { reference: 'asc' },
        });
        for (const risk of risks) {
          const r = sh.risks.addRow([
            projectId, risk.id, risk.reference, risk.title,
            risk.description ?? null,
            risk.probability, risk.impact, risk.score,
            risk.response, risk.mitigationPlan ?? null,
            risk.ownerId ?? null,
            null, null, null,
          ]);
          dateCell(sh.risks, r, 12, risk.dueDate);
          dateCell(sh.risks, r, 13, risk.closedAt);
          dateCell(sh.risks, r, 14, risk.createdAt);
        }
      }

      // ── Change requests ───────────────────────────────────────────────────
      if (hasChangeControl) {
        const crs = await prisma.changeRequest.findMany({
          where: { teamId, projectId },
          orderBy: { reference: 'asc' },
        });
        for (const cr of crs) {
          const r = sh.change_requests.addRow([
            projectId, cr.id, cr.reference, cr.title,
            cr.description ?? null, cr.status,
            cr.scheduleDeltaDays ?? null,
            bigintToNum(cr.costImpactMinor), cr.costCurrency ?? null,
            null, null, null,
          ]);
          dateCell(sh.change_requests, r, 10, cr.submittedAt);
          dateCell(sh.change_requests, r, 11, cr.decidedAt);
          dateCell(sh.change_requests, r, 12, cr.createdAt);
        }
      }

      // ── Contracts + POs ───────────────────────────────────────────────────
      if (hasProcurement) {
        const contracts = await prisma.contract.findMany({
          where: { teamId, projectId },
          orderBy: { reference: 'asc' },
        });
        for (const c of contracts) {
          const r = sh.contracts.addRow([
            projectId, c.id, c.vendorId ?? null,
            c.reference, c.title, c.status,
            bigintToNum(c.valueMinor), c.currency ?? null,
            null, null,
            c.notes ?? null,
            null,
          ]);
          dateCell(sh.contracts, r, 9, c.startDate);
          dateCell(sh.contracts, r, 10, c.endDate);
          dateCell(sh.contracts, r, 12, c.createdAt);
        }

        const pos = await prisma.purchaseOrder.findMany({
          where: { teamId, projectId },
          orderBy: { reference: 'asc' },
        });
        for (const po of pos) {
          const r = sh.purchase_orders.addRow([
            projectId, po.id, po.contractId ?? null,
            po.reference, po.title, po.status,
            bigintToNum(po.amountMinor), po.currency ?? null,
            null, null, null,
            null,
          ]);
          dateCell(sh.purchase_orders, r, 9, po.issuedDate);
          dateCell(sh.purchase_orders, r, 10, po.expectedDate);
          dateCell(sh.purchase_orders, r, 11, po.receivedDate);
          dateCell(sh.purchase_orders, r, 12, po.createdAt);
        }
      }

      // ── Quality NCRs ──────────────────────────────────────────────────────
      if (hasQuality) {
        const ncrs = await prisma.qualityNcr.findMany({
          where: { teamId, projectId },
          orderBy: { reference: 'asc' },
        });
        for (const n of ncrs) {
          const r = sh.quality_ncrs.addRow([
            projectId, n.id, n.reference, n.title,
            n.description ?? null, n.severity, n.disposition ?? null,
            null, null,
          ]);
          dateCell(sh.quality_ncrs, r, 8, n.closedAt);
          dateCell(sh.quality_ncrs, r, 9, n.createdAt);
        }
      }

      // ── Baselines ─────────────────────────────────────────────────────────
      if (hasBaselines) {
        const bls = await prisma.projectBaseline.findMany({
          where: { teamId, projectId },
          orderBy: { capturedAt: 'desc' },
        });
        // Count entries for all baselines in one groupBy rather than per-row.
        const counts = await prisma.baselineEntry.groupBy({
          by: ['baselineId'],
          where: { baselineId: { in: bls.map((b) => b.id) } },
          _count: { _all: true },
        });
        const countByBaseline = new Map(counts.map((c) => [c.baselineId, c._count._all]));
        for (const b of bls) {
          const r = sh.baselines.addRow([
            projectId, b.id, b.name, b.source, b.isCurrent,
            b.capturedById ?? null,
            null,
            countByBaseline.get(b.id) ?? 0,
          ]);
          dateCell(sh.baselines, r, 7, b.capturedAt);
        }
      }
    }

    const buf = await wb.xlsx.writeBuffer();
    return Buffer.from(buf);
  }
}

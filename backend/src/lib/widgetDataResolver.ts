import { Decimal } from '@prisma/client/runtime/library';
import type { DashboardWidget, Prisma } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors } from './errors.js';
import {
  buildTaskWhereFromFilters,
  OPEN_STATUSES,
  parseGroupBy,
} from './widgetFilters.js';
import { ReportsService, type ReportCaller } from '../services/reportsService.js';
import { projectListWhereForCaller } from './projectAccess.js';
import type { WidgetConfig, WidgetFilters } from '../schemas/dashboards.js';

export interface WidgetDataRow {
  key: string;
  label: string;
  value: number | string;
}

export interface WidgetSeriesPoint {
  bucket: string;
  label: string;
  value: number;
}

export interface WidgetDataResult {
  kind: 'metric' | 'grouped' | 'series' | 'table';
  total?: number | string;
  rows?: WidgetDataRow[];
  series?: WidgetSeriesPoint[];
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const reports = new ReportsService();

function hasActiveFilters(filters: WidgetFilters | null | undefined): boolean {
  return Boolean(filters?.conditions?.length);
}

function decimalToString(d: Decimal | null | undefined): string {
  if (d == null) return '0';
  return d.toFixed(2);
}

function sumDecimals(values: (Decimal | null | undefined)[]): string {
  let acc = new Decimal(0);
  for (const v of values) {
    if (v != null) acc = acc.add(v);
  }
  return acc.toFixed(2);
}

export class WidgetDataResolver {
  async resolve(
    teamId: string,
    widget: DashboardWidget,
    caller: ReportCaller,
  ): Promise<WidgetDataResult> {
    const filters = widget.filtersJson as WidgetFilters | null;
    const config = widget.configJson as WidgetConfig | null;
    const where = buildTaskWhereFromFilters(teamId, filters);
    // A widget is a cross-project aggregate over the team, but dashboards are
    // readable by any team member while project visibility is owner/grant
    // based. Clamp every task query to the caller's visible project set — this
    // `where` is threaded into every branch below, so one assignment covers
    // them all. The paths that bypass `where` (the unfiltered ReportsService
    // short-circuits) take `caller` instead.
    where.project = await projectListWhereForCaller(teamId, caller.userId, caller.globalRole);

    if (widget.type === 'LINE') {
      return this.resolveLine(widget, where, config);
    }

    if (!widget.groupBy && widget.type === 'METRIC') {
      return this.resolveMetric(teamId, widget, where, filters, config, caller);
    }

    if (!widget.groupBy) {
      throw Errors.badRequest('Grouped widget types require groupBy');
    }

    const parsed = parseGroupBy(widget.groupBy);
    if (!parsed) {
      throw Errors.badRequest('Invalid groupBy');
    }

    if (parsed.kind === 'custom_field') {
      await this.assertCustomField(teamId, parsed.fieldId);
      return this.resolveCustomFieldGroup(teamId, widget, where, parsed.fieldId);
    }

    const rows = await this.resolveBuiltinGroup(
      teamId,
      widget,
      where,
      filters,
      parsed.dimension,
      caller,
    );

    const kind = widget.type === 'TABLE' ? 'table' : 'grouped';
    return { kind, rows };
  }

  private async resolveMetric(
    teamId: string,
    widget: DashboardWidget,
    where: Prisma.TaskWhereInput,
    filters: WidgetFilters | null | undefined,
    config: WidgetConfig | null | undefined,
    caller: ReportCaller,
  ): Promise<WidgetDataResult> {
    switch (widget.dataSource) {
      case 'task_count': {
        if (!hasActiveFilters(filters)) {
          const summary = await reports.summary(teamId, caller);
          return { kind: 'metric', total: summary.openCount + summary.byStatus.DONE };
        }
        const total = await prisma.task.count({ where });
        return { kind: 'metric', total };
      }
      case 'planned_budget_sum': {
        const agg = await prisma.task.aggregate({
          where,
          _sum: { plannedBudget: true },
        });
        return { kind: 'metric', total: decimalToString(agg._sum.plannedBudget) };
      }
      case 'actual_spent_sum': {
        const agg = await prisma.task.aggregate({
          where,
          _sum: { actualSpent: true },
        });
        return { kind: 'metric', total: decimalToString(agg._sum.actualSpent) };
      }
      case 'custom_field_number_sum': {
        const fieldId = config?.customFieldId;
        if (!fieldId) throw Errors.badRequest('customFieldId required for custom_field_number_sum');
        await this.assertCustomField(teamId, fieldId, 'NUMBER');
        const total = await this.sumCustomFieldNumber(fieldId, where);
        return { kind: 'metric', total };
      }
      default:
        throw Errors.badRequest('Unknown dataSource');
    }
  }

  private async resolveBuiltinGroup(
    teamId: string,
    widget: DashboardWidget,
    where: Prisma.TaskWhereInput,
    filters: WidgetFilters | null | undefined,
    dimension: string,
    caller: ReportCaller,
  ): Promise<WidgetDataRow[]> {
    const isSum =
      widget.dataSource === 'planned_budget_sum' ||
      widget.dataSource === 'actual_spent_sum' ||
      widget.dataSource === 'custom_field_number_sum';

    switch (dimension) {
      case 'status':
        return this.groupByStatus(teamId, widget, where, filters, isSum, caller);
      case 'priority':
        return this.groupBySimpleField(widget, where, 'priority', isSum);
      case 'assignee':
        return this.groupByAssignee(teamId, widget, where, filters, isSum, caller);
      case 'project':
        return this.groupByProject(teamId, widget, where, isSum);
      case 'label':
        return this.groupByLabel(teamId, widget, where, isSum);
      case 'due_bucket':
        return this.groupByDueBucket(widget, where, isSum);
      default:
        throw Errors.badRequest(`Unsupported groupBy: ${dimension}`);
    }
  }

  private async groupByStatus(
    teamId: string,
    widget: DashboardWidget,
    where: Prisma.TaskWhereInput,
    filters: WidgetFilters | null | undefined,
    isSum: boolean,
    caller: ReportCaller,
  ): Promise<WidgetDataRow[]> {
    if (
      !isSum &&
      widget.dataSource === 'task_count' &&
      !hasActiveFilters(filters)
    ) {
      const summary = await reports.summary(teamId, caller);
      return (['TODO', 'IN_PROGRESS', 'REVIEW', 'DONE'] as const).map((s) => ({
        key: s,
        label: s,
        value: summary.byStatus[s],
      }));
    }

    if (isSum) {
      return this.groupBySimpleField(widget, where, 'status', true);
    }

    const groups = await prisma.task.groupBy({
      by: ['status'],
      where,
      _count: { _all: true },
    });
    return groups.map((g) => ({
      key: g.status,
      label: g.status,
      value: g._count._all,
    }));
  }

  private async groupByAssignee(
    teamId: string,
    widget: DashboardWidget,
    where: Prisma.TaskWhereInput,
    filters: WidgetFilters | null | undefined,
    isSum: boolean,
    caller: ReportCaller,
  ): Promise<WidgetDataRow[]> {
    if (
      !isSum &&
      widget.dataSource === 'task_count' &&
      !hasActiveFilters(filters)
    ) {
      const workload = await reports.listWorkload(teamId, caller);
      return workload.map((w) => ({
        key: w.assigneeId ?? '__unassigned__',
        label: w.assigneeName ?? 'Unassigned',
        value: w.total,
      }));
    }

    const rows = await prisma.task.findMany({
      where,
      select: {
        assigneeId: true,
        assignee: { select: { name: true } },
        plannedBudget: true,
        actualSpent: true,
      },
    });

    const buckets = new Map<string, { label: string; count: number; sums: Decimal[] }>();
    for (const r of rows) {
      const key = r.assigneeId ?? '__unassigned__';
      let b = buckets.get(key);
      if (!b) {
        b = { label: r.assignee?.name ?? 'Unassigned', count: 0, sums: [] };
        buckets.set(key, b);
      }
      b.count += 1;
      if (isSum) this.pushSum(widget, r, b.sums);
    }

    return [...buckets.entries()].map(([key, b]) => ({
      key,
      label: b.label,
      value: isSum ? sumDecimals(b.sums) : b.count,
    }));
  }

  private async groupBySimpleField(
    widget: DashboardWidget,
    where: Prisma.TaskWhereInput,
    field: 'status' | 'priority',
    isSum: boolean,
  ): Promise<WidgetDataRow[]> {
    if (!isSum) {
      const groups = await prisma.task.groupBy({
        by: [field],
        where,
        _count: { _all: true },
      });
      return groups.map((g) => ({
        key: String(g[field]),
        label: String(g[field]),
        value: g._count._all,
      }));
    }

    const sumField =
      widget.dataSource === 'planned_budget_sum' ? 'plannedBudget' : 'actualSpent';
    const rows = await prisma.task.findMany({
      where,
      select: { status: true, priority: true, plannedBudget: true, actualSpent: true },
    });
    const buckets = new Map<string, Decimal[]>();
    for (const r of rows) {
      const key = String(r[field]);
      const val = sumField === 'plannedBudget' ? r.plannedBudget : r.actualSpent;
      if (val == null) continue;
      const list = buckets.get(key) ?? [];
      list.push(val);
      buckets.set(key, list);
    }
    return [...buckets.entries()].map(([key, sums]) => ({
      key,
      label: key,
      value: sumDecimals(sums),
    }));
  }

  private async groupByProject(
    teamId: string,
    widget: DashboardWidget,
    where: Prisma.TaskWhereInput,
    isSum: boolean,
  ): Promise<WidgetDataRow[]> {
    const projects = await prisma.project.findMany({
      where: { teamId },
      select: { id: true, name: true },
    });
    const nameById = new Map(projects.map((p) => [p.id, p.name]));

    if (!isSum) {
      const groups = await prisma.task.groupBy({
        by: ['projectId'],
        where,
        _count: { _all: true },
      });
      return groups.map((g) => ({
        key: g.projectId,
        label: nameById.get(g.projectId) ?? g.projectId,
        value: g._count._all,
      }));
    }

    const sumField =
      widget.dataSource === 'planned_budget_sum' ? 'plannedBudget' : 'actualSpent';
    const rows = await prisma.task.findMany({
      where,
      select: { projectId: true, plannedBudget: true, actualSpent: true },
    });
    const buckets = new Map<string, Decimal[]>();
    for (const r of rows) {
      const val = sumField === 'plannedBudget' ? r.plannedBudget : r.actualSpent;
      if (val == null) continue;
      const list = buckets.get(r.projectId) ?? [];
      list.push(val);
      buckets.set(r.projectId, list);
    }
    return [...buckets.entries()].map(([key, sums]) => ({
      key,
      label: nameById.get(key) ?? key,
      value: sumDecimals(sums),
    }));
  }

  private async groupByLabel(
    teamId: string,
    widget: DashboardWidget,
    where: Prisma.TaskWhereInput,
    isSum: boolean,
  ): Promise<WidgetDataRow[]> {
    const labels = await prisma.label.findMany({
      where: { teamId },
      select: { id: true, name: true },
    });
    const nameById = new Map(labels.map((l) => [l.id, l.name]));

    const taskRows = await prisma.task.findMany({
      where,
      select: {
        id: true,
        plannedBudget: true,
        actualSpent: true,
        labels: { select: { labelId: true } },
      },
    });

    const buckets = new Map<string, { count: number; sums: Decimal[] }>();
    for (const t of taskRows) {
      if (t.labels.length === 0) {
        const b = buckets.get('__none__') ?? { count: 0, sums: [] };
        b.count += 1;
        if (isSum) this.pushSum(widget, t, b.sums);
        buckets.set('__none__', b);
        continue;
      }
      for (const tl of t.labels) {
        const b = buckets.get(tl.labelId) ?? { count: 0, sums: [] };
        b.count += 1;
        if (isSum) this.pushSum(widget, t, b.sums);
        buckets.set(tl.labelId, b);
      }
    }

    return [...buckets.entries()].map(([key, b]) => ({
      key,
      label: key === '__none__' ? '(none)' : (nameById.get(key) ?? key),
      value: isSum ? sumDecimals(b.sums) : b.count,
    }));
  }

  private pushSum(
    widget: DashboardWidget,
    t: { plannedBudget: Decimal | null; actualSpent: Decimal | null },
    sums: Decimal[],
  ): void {
    if (widget.dataSource === 'planned_budget_sum' && t.plannedBudget != null) {
      sums.push(t.plannedBudget);
    }
    if (widget.dataSource === 'actual_spent_sum' && t.actualSpent != null) {
      sums.push(t.actualSpent);
    }
  }

  private async groupByDueBucket(
    widget: DashboardWidget,
    where: Prisma.TaskWhereInput,
    isSum: boolean,
  ): Promise<WidgetDataRow[]> {
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setUTCHours(0, 0, 0, 0);
    const tomorrowStart = new Date(todayStart.getTime() + MS_PER_DAY);
    const weekEnd = new Date(todayStart.getTime() + 7 * MS_PER_DAY);

    const openWhere = {
      ...where,
      status: { in: OPEN_STATUSES },
    };

    const rows = await prisma.task.findMany({
      where: openWhere,
      select: { dueDate: true, plannedBudget: true, actualSpent: true },
    });

    const buckets: Record<string, { count: number; sums: Decimal[] }> = {
      overdue: { count: 0, sums: [] },
      today: { count: 0, sums: [] },
      this_week: { count: 0, sums: [] },
      later: { count: 0, sums: [] },
      no_due: { count: 0, sums: [] },
    };

    for (const r of rows) {
      let bucket: keyof typeof buckets;
      if (!r.dueDate) {
        bucket = 'no_due';
      } else if (r.dueDate < todayStart) {
        bucket = 'overdue';
      } else if (r.dueDate >= todayStart && r.dueDate < tomorrowStart) {
        bucket = 'today';
      } else if (r.dueDate >= tomorrowStart && r.dueDate < weekEnd) {
        bucket = 'this_week';
      } else {
        bucket = 'later';
      }
      buckets[bucket]!.count += 1;
      if (isSum) this.pushSum(widget, r, buckets[bucket]!.sums);
    }

    const order = ['overdue', 'today', 'this_week', 'later', 'no_due'] as const;
    return order.map((key) => ({
      key,
      label: key,
      value: isSum ? sumDecimals(buckets[key]!.sums) : buckets[key]!.count,
    }));
  }

  private async resolveCustomFieldGroup(
    teamId: string,
    widget: DashboardWidget,
    where: Prisma.TaskWhereInput,
    fieldId: string,
  ): Promise<WidgetDataResult> {
    const field = await this.assertCustomField(teamId, fieldId);

    if (field.type === 'NUMBER' && widget.dataSource === 'custom_field_number_sum') {
      const rows = await prisma.task.findMany({
        where,
        select: {
          id: true,
          customFieldValues: {
            where: { fieldId },
            select: { valueNumber: true },
          },
        },
      });
      const buckets = new Map<string, Decimal[]>();
      for (const t of rows) {
        const v = t.customFieldValues[0]?.valueNumber;
        if (v == null) continue;
        const key = v.toFixed(4);
        const list = buckets.get(key) ?? [];
        list.push(v);
        buckets.set(key, list);
      }
      const groupedRows = [...buckets.entries()].map(([key, sums]) => ({
        key,
        label: key,
        value: sumDecimals(sums),
      }));
      return { kind: widget.type === 'TABLE' ? 'table' : 'grouped', rows: groupedRows };
    }

    if (field.type !== 'SINGLE_SELECT' && field.type !== 'MULTI_SELECT') {
      throw Errors.badRequest('Custom field groupBy requires a select field');
    }

    if (widget.dataSource !== 'task_count') {
      throw Errors.badRequest('SELECT custom field groupBy only supports task_count');
    }

    const options = await prisma.customFieldOption.findMany({
      where: { fieldId },
      orderBy: { position: 'asc' },
    });

    const taskIds = (
      await prisma.task.findMany({ where, select: { id: true } })
    ).map((t) => t.id);

    if (taskIds.length === 0) {
      return { kind: widget.type === 'TABLE' ? 'table' : 'grouped', rows: [] };
    }

    const values = await prisma.customFieldValue.findMany({
      where: { fieldId, taskId: { in: taskIds } },
      include: { selections: { select: { optionId: true } } },
    });

    const counts = new Map<string, number>();
    for (const o of options) counts.set(o.id, 0);
    counts.set('__unset__', 0);

    const countedTasks = new Set<string>();
    for (const v of values) {
      if (v.selections.length === 0) {
        counts.set('__unset__', (counts.get('__unset__') ?? 0) + 1);
      } else {
        for (const s of v.selections) {
          counts.set(s.optionId, (counts.get(s.optionId) ?? 0) + 1);
        }
      }
      countedTasks.add(v.taskId);
    }

    for (const tid of taskIds) {
      if (!countedTasks.has(tid)) {
        counts.set('__unset__', (counts.get('__unset__') ?? 0) + 1);
      }
    }

    const rows: WidgetDataRow[] = [];
    for (const o of options) {
      rows.push({
        key: o.id,
        label: o.label,
        value: counts.get(o.id) ?? 0,
      });
    }
    rows.push({
      key: '__unset__',
      label: '(unset)',
      value: counts.get('__unset__') ?? 0,
    });

    return { kind: widget.type === 'TABLE' ? 'table' : 'grouped', rows };
  }

  private async resolveLine(
    widget: DashboardWidget,
    where: Prisma.TaskWhereInput,
    config: WidgetConfig | null | undefined,
  ): Promise<WidgetDataResult> {
    if (widget.dataSource !== 'task_count') {
      throw Errors.badRequest('LINE widgets only support task_count in v1');
    }

    const timeField = config?.timeField ?? 'completedAt';
    const bucket = widget.timeBucket ?? 'week';
    const days = config?.lineDays ?? 30;
    const since = new Date(Date.now() - days * MS_PER_DAY);

    const dateFilter =
      timeField === 'completedAt'
        ? { completedAt: { gte: since, not: null } }
        : { createdAt: { gte: since } };

    const rows = await prisma.task.findMany({
      where: { ...where, ...dateFilter },
      select: { completedAt: true, createdAt: true },
    });

    const buckets = new Map<string, number>();
    for (const r of rows) {
      const dt = timeField === 'completedAt' ? r.completedAt : r.createdAt;
      if (!dt) continue;
      const key = bucketKey(dt, bucket);
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }

    const series = [...buckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => ({
        bucket: key,
        label: key,
        value,
      }));

    return { kind: 'series', series };
  }

  private async sumCustomFieldNumber(
    fieldId: string,
    where: Prisma.TaskWhereInput,
  ): Promise<string> {
    const taskIds = (
      await prisma.task.findMany({ where, select: { id: true } })
    ).map((t) => t.id);
    if (taskIds.length === 0) return '0.00';

    const values = await prisma.customFieldValue.findMany({
      where: { fieldId, taskId: { in: taskIds } },
      select: { valueNumber: true },
    });
    return sumDecimals(values.map((v) => v.valueNumber));
  }

  private async assertCustomField(
    teamId: string,
    fieldId: string,
    expectedType?: 'NUMBER' | 'SINGLE_SELECT' | 'MULTI_SELECT',
  ) {
    const field = await prisma.customFieldDefinition.findFirst({
      where: { id: fieldId, teamId },
    });
    if (!field) throw Errors.notFound('Custom field not found');
    if (expectedType && field.type !== expectedType) {
      throw Errors.badRequest(`Custom field must be ${expectedType}`);
    }
    return field;
  }
}

function bucketKey(dt: Date, bucket: string): string {
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  if (bucket === 'day') return `${y}-${m}-${d}`;
  if (bucket === 'month') return `${y}-${m}`;
  const jan1 = new Date(Date.UTC(y, 0, 1));
  const week = Math.ceil(((dt.getTime() - jan1.getTime()) / MS_PER_DAY + jan1.getUTCDay() + 1) / 7);
  return `${y}-W${String(week).padStart(2, '0')}`;
}

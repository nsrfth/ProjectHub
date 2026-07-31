import type { Dashboard, DashboardWidget, TeamRole } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';
import { WidgetDataResolver, type WidgetDataResult } from '../lib/widgetDataResolver.js';
import type { ReportCaller } from './reportsService.js';
import type {
  CreateDashboardBody,
  DashboardWidgetInput,
  SetDashboardWidgetsBody,
  UpdateDashboardBody,
} from '../schemas/dashboards.js';

export interface DashboardWidgetView {
  id: string;
  dashboardId: string;
  type: string;
  title: string;
  dataSource: string;
  groupBy: string | null;
  timeBucket: string | null;
  filtersJson: unknown;
  configJson: unknown;
  position: number;
}

export interface DashboardView {
  id: string;
  teamId: string;
  ownerId: string;
  name: string;
  description: string | null;
  shared: boolean;
  position: number;
  createdAt: Date;
  updatedAt: Date;
  widgets: DashboardWidgetView[];
}

export interface DashboardListItem {
  id: string;
  teamId: string;
  ownerId: string;
  name: string;
  description: string | null;
  shared: boolean;
  position: number;
  createdAt: Date;
  updatedAt: Date;
  widgetCount: number;
  canEdit: boolean;
}

function canEditDashboard(
  dashboard: Pick<Dashboard, 'ownerId'>,
  userId: string,
  teamRole: TeamRole,
): boolean {
  return dashboard.ownerId === userId || teamRole === 'MANAGER';
}

function canReadDashboard(
  dashboard: Pick<Dashboard, 'ownerId' | 'shared'>,
  userId: string,
): boolean {
  return dashboard.ownerId === userId || dashboard.shared;
}

function toWidgetView(w: DashboardWidget): DashboardWidgetView {
  return {
    id: w.id,
    dashboardId: w.dashboardId,
    type: w.type,
    title: w.title,
    dataSource: w.dataSource,
    groupBy: w.groupBy,
    timeBucket: w.timeBucket,
    filtersJson: w.filtersJson,
    configJson: w.configJson,
    position: w.position,
  };
}

function toDashboardView(d: Dashboard & { widgets: DashboardWidget[] }): DashboardView {
  return {
    id: d.id,
    teamId: d.teamId,
    ownerId: d.ownerId,
    name: d.name,
    description: d.description,
    shared: d.shared,
    position: d.position,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    widgets: d.widgets.sort((a, b) => a.position - b.position).map(toWidgetView),
  };
}

export class DashboardsService {
  private readonly resolver = new WidgetDataResolver();

  async list(teamId: string, userId: string, teamRole: TeamRole): Promise<DashboardListItem[]> {
    const rows = await prisma.dashboard.findMany({
      where: {
        teamId,
        OR: [{ ownerId: userId }, { shared: true }],
      },
      include: { _count: { select: { widgets: true } } },
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
    });

    return rows.map((d) => ({
      id: d.id,
      teamId: d.teamId,
      ownerId: d.ownerId,
      name: d.name,
      description: d.description,
      shared: d.shared,
      position: d.position,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      widgetCount: d._count.widgets,
      canEdit: canEditDashboard(d, userId, teamRole),
    }));
  }

  async get(
    teamId: string,
    dashboardId: string,
    userId: string,
    teamRole: TeamRole,
  ): Promise<DashboardView & { canEdit: boolean }> {
    const d = await this.loadDashboard(teamId, dashboardId);
    if (!canReadDashboard(d, userId)) throw Errors.forbidden();
    return {
      ...toDashboardView(d),
      canEdit: canEditDashboard(d, userId, teamRole),
    };
  }

  async create(
    teamId: string,
    userId: string,
    body: CreateDashboardBody,
  ): Promise<DashboardView> {
    const created = await prisma.dashboard.create({
      data: {
        teamId,
        ownerId: userId,
        name: body.name,
        description: body.description ?? null,
        shared: body.shared ?? false,
        position: body.position ?? 0,
        widgets: body.widgets?.length
          ? {
              create: body.widgets.map((w, i) => widgetCreateData(w, i)),
            }
          : undefined,
      },
      include: { widgets: true },
    });
    return toDashboardView(created);
  }

  async update(
    teamId: string,
    dashboardId: string,
    userId: string,
    teamRole: TeamRole,
    body: UpdateDashboardBody,
  ): Promise<DashboardView & { canEdit: boolean }> {
    const existing = await this.loadDashboard(teamId, dashboardId);
    if (!canEditDashboard(existing, userId, teamRole)) throw Errors.forbidden();

    const updated = await prisma.dashboard.update({
      where: { id: dashboardId },
      data: {
        name: body.name,
        description: body.description,
        shared: body.shared,
        position: body.position,
      },
      include: { widgets: true },
    });
    return {
      ...toDashboardView(updated),
      canEdit: true,
    };
  }

  async delete(
    teamId: string,
    dashboardId: string,
    userId: string,
    teamRole: TeamRole,
  ): Promise<void> {
    const existing = await this.loadDashboard(teamId, dashboardId);
    if (!canEditDashboard(existing, userId, teamRole)) throw Errors.forbidden();
    await prisma.dashboard.delete({ where: { id: dashboardId } });
  }

  async setWidgets(
    teamId: string,
    dashboardId: string,
    userId: string,
    teamRole: TeamRole,
    body: SetDashboardWidgetsBody,
  ): Promise<DashboardView & { canEdit: boolean }> {
    const existing = await this.loadDashboard(teamId, dashboardId);
    if (!canEditDashboard(existing, userId, teamRole)) throw Errors.forbidden();

    await prisma.$transaction(async (tx) => {
      await tx.dashboardWidget.deleteMany({ where: { dashboardId } });
      if (body.widgets.length > 0) {
        await tx.dashboardWidget.createMany({
          data: body.widgets.map((w, i) => {
            const row = {
              dashboardId,
              type: w.type,
              title: w.title,
              dataSource: w.dataSource,
              groupBy: w.groupBy ?? null,
              timeBucket: w.timeBucket ?? null,
              filtersJson: w.filtersJson ?? undefined,
              configJson: w.configJson ?? undefined,
              position: w.position ?? i,
            };
            return w.id ? { ...row, id: w.id } : row;
          }),
        });
      }
    });

    return this.get(teamId, dashboardId, userId, teamRole);
  }

  async resolveWidgetData(
    teamId: string,
    dashboardId: string,
    widgetId: string,
    caller: ReportCaller,
  ): Promise<WidgetDataResult> {
    const d = await this.loadDashboard(teamId, dashboardId);
    if (!canReadDashboard(d, caller.userId)) throw Errors.forbidden();

    const widget = d.widgets.find((w) => w.id === widgetId);
    if (!widget) throw Errors.notFound('Widget not found');

    // Reading the dashboard is not the same as being allowed to see every
    // project it aggregates — the resolver clamps the data to `caller`.
    return this.resolver.resolve(teamId, widget, caller);
  }

  private async loadDashboard(teamId: string, dashboardId: string) {
    const d = await prisma.dashboard.findFirst({
      where: { id: dashboardId, teamId },
      include: { widgets: { orderBy: { position: 'asc' } } },
    });
    if (!d) throw Errors.notFound('Dashboard not found');
    return d;
  }
}

function widgetCreateData(w: DashboardWidgetInput, index: number) {
  return {
    id: w.id,
    type: w.type,
    title: w.title,
    dataSource: w.dataSource,
    groupBy: w.groupBy ?? null,
    timeBucket: w.timeBucket ?? null,
    filtersJson: w.filtersJson ?? undefined,
    configJson: w.configJson ?? undefined,
    position: w.position ?? index,
  };
}

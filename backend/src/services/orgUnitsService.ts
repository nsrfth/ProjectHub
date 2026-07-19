import { Prisma, type OrgUnitType } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { buildCurrencyRollups, computeProjectBudgetMetrics } from '../lib/budgetReportMath.js';
import { Errors } from '../lib/errors.js';
import { applyOrgGrantPolicies } from '../lib/projectGrants.js';
import {
  assertNoCycle,
  assertValidParentType,
  orgUnitPath,
  subtreePathPrefix,
} from '../lib/orgUnitTree.js';
import type {
  CreateOrgUnitBody,
  MoveOrgUnitBody,
  SetProjectOrgUnitBody,
  UpdateOrgUnitBody,
} from '../schemas/orgUnits.js';
import { logActivity } from './activityLogger.js';

export interface OrgUnitView {
  id: string;
  parentId: string | null;
  type: OrgUnitType;
  name: string;
  code: string;
  path: string;
  managerId: string | null;
  managerName: string | null;
  currency: string | null;
  childCount: number;
  projectCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface OrgUnitTreeNode extends OrgUnitView {
  children: OrgUnitTreeNode[];
}

const ORG_INCLUDE = {
  manager: { select: { name: true } },
  _count: { select: { children: true, projects: true } },
} as const;

type OrgRow = Prisma.OrgUnitGetPayload<{ include: typeof ORG_INCLUDE }>;

function toView(row: OrgRow): OrgUnitView {
  return {
    id: row.id,
    parentId: row.parentId,
    type: row.type,
    name: row.name,
    code: row.code,
    path: row.path,
    managerId: row.managerId,
    managerName: row.manager?.name ?? null,
    currency: row.currency,
    childCount: row._count.children,
    projectCount: row._count.projects,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function buildTree(rows: OrgUnitView[]): OrgUnitTreeNode[] {
  const byId = new Map<string, OrgUnitTreeNode>();
  for (const r of rows) byId.set(r.id, { ...r, children: [] });
  const roots: OrgUnitTreeNode[] = [];
  for (const node of byId.values()) {
    if (node.parentId && byId.has(node.parentId)) {
      byId.get(node.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const sortRec = (nodes: OrgUnitTreeNode[]): void => {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    for (const n of nodes) sortRec(n.children);
  };
  sortRec(roots);
  return roots;
}

// v1.99 (PMIS R3): OrgUnit CRUD + project attach + subtree roll-up reports.
// Org units are global (above Team); portfolio.* permissions gate access.
// Project attach re-asserts the team/project chain for existence-hiding 404s.
export class OrgUnitsService {
  private async getRow(id: string): Promise<OrgRow> {
    const row = await prisma.orgUnit.findUnique({ where: { id }, include: ORG_INCLUDE });
    if (!row) throw Errors.notFound('Org unit not found');
    return row;
  }

  private async descendantIds(root: OrgRow): Promise<string[]> {
    const prefix = subtreePathPrefix(root.path);
    const rows = await prisma.orgUnit.findMany({
      where: { OR: [{ id: root.id }, { path: { startsWith: prefix } }] },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  async listFlat(): Promise<OrgUnitView[]> {
    const rows = await prisma.orgUnit.findMany({
      include: ORG_INCLUDE,
      orderBy: [{ path: 'asc' }],
    });
    return rows.map(toView);
  }

  async listTree(): Promise<OrgUnitTreeNode[]> {
    return buildTree(await this.listFlat());
  }

  async get(id: string): Promise<OrgUnitView> {
    return toView(await this.getRow(id));
  }

  async create(actorId: string, input: CreateOrgUnitBody): Promise<OrgUnitView> {
    const parentId = input.parentId ?? null;
    let parent: OrgRow | null = null;
    if (parentId) parent = await this.getRow(parentId);
    assertValidParentType(input.type, parent?.type ?? null);

    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.orgUnit.create({
        data: {
          parentId,
          type: input.type,
          name: input.name,
          code: input.code,
          path: 'pending', // set below once id is known
          managerId: input.managerId ?? null,
          currency: input.currency ?? null,
        },
      });
      const path = orgUnitPath(created.id, parent?.path ?? null);
      const updated = await tx.orgUnit.update({
        where: { id: created.id },
        data: { path },
        include: ORG_INCLUDE,
      });
      await logActivity(tx, {
        teamId: null,
        actorId,
        action: 'org_unit.created',
        meta: { orgUnitId: updated.id, type: updated.type, code: updated.code },
      });
      return updated;
    });
    return toView(row);
  }

  async update(id: string, actorId: string, input: UpdateOrgUnitBody): Promise<OrgUnitView> {
    await this.getRow(id);
    const row = await prisma.orgUnit.update({
      where: { id },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.managerId !== undefined && { managerId: input.managerId }),
        ...(input.currency !== undefined && { currency: input.currency }),
      },
      include: ORG_INCLUDE,
    });
    await logActivity(prisma, {
      teamId: null,
      actorId,
      action: 'org_unit.updated',
      meta: { orgUnitId: id },
    });
    return toView(row);
  }

  async remove(id: string, actorId: string): Promise<void> {
    const row = await this.getRow(id);
    if (row._count.children > 0) {
      throw Errors.conflict('Remove child org units before deleting this one');
    }
    if (row._count.projects > 0) {
      throw Errors.conflict('Detach all projects before deleting this org unit');
    }
    await prisma.orgUnit.delete({ where: { id } });
    await logActivity(prisma, {
      teamId: null,
      actorId,
      action: 'org_unit.deleted',
      meta: { orgUnitId: id, code: row.code },
    });
  }

  async move(id: string, actorId: string, input: MoveOrgUnitBody): Promise<OrgUnitView> {
    const node = await this.getRow(id);
    const newParentId = input.newParentId;
    let newParent: OrgRow | null = null;
    if (newParentId) newParent = await this.getRow(newParentId);
    assertValidParentType(node.type, newParent?.type ?? null);
    assertNoCycle(id, newParentId, newParent?.path ?? null);

    const oldPrefix = subtreePathPrefix(node.path);
    const newBasePath = orgUnitPath(id, newParent?.path ?? null);
    const newPrefix = subtreePathPrefix(newBasePath);

    const row = await prisma.$transaction(async (tx) => {
      await tx.orgUnit.update({
        where: { id },
        data: { parentId: newParentId, path: newBasePath },
      });
      const descendants = await tx.orgUnit.findMany({
        where: { path: { startsWith: oldPrefix } },
        select: { id: true, path: true },
      });
      for (const d of descendants) {
        const suffix = d.path.slice(oldPrefix.length);
        await tx.orgUnit.update({
          where: { id: d.id },
          data: { path: `${newPrefix}${suffix}` },
        });
      }
      return tx.orgUnit.findUniqueOrThrow({ where: { id }, include: ORG_INCLUDE });
    });
    await logActivity(prisma, {
      teamId: null,
      actorId,
      action: 'org_unit.moved',
      meta: { orgUnitId: id, newParentId },
    });
    return toView(row);
  }

  // v2.5.51: read-only lookup of a project's current org-unit attachment so the
  // project edit picker can pre-select it. Mirrors setProjectOrgUnit's shape.
  async getProjectOrgUnit(
    teamId: string,
    projectId: string,
  ): Promise<{ projectId: string; orgUnitId: string | null; orgUnitName: string | null }> {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, teamId: true, orgUnitId: true, orgUnit: { select: { name: true } } },
    });
    if (!project || project.teamId !== teamId) throw Errors.notFound('Project not found');
    return {
      projectId: project.id,
      orgUnitId: project.orgUnitId,
      orgUnitName: project.orgUnit?.name ?? null,
    };
  }

  /**
   * v2.17: the division <-> company link, via TeamOrgUnit — the shipped
   * default-attachment table (non-RBAC, exactly as its schema comment says).
   * Single-company semantics: PUT replaces the whole link set.
   */
  async getTeamOrgUnit(teamId: string): Promise<{ orgUnitId: string; orgUnitName: string } | null> {
    const link = await prisma.teamOrgUnit.findFirst({
      where: { teamId },
      include: { orgUnit: { select: { id: true, name: true } } },
    });
    return link ? { orgUnitId: link.orgUnit.id, orgUnitName: link.orgUnit.name } : null;
  }

  async setTeamOrgUnit(
    teamId: string,
    actorId: string,
    orgUnitId: string | null,
  ): Promise<{ orgUnitId: string; orgUnitName: string } | null> {
    if (orgUnitId) {
      const node = await prisma.orgUnit.findUnique({ where: { id: orgUnitId } });
      if (!node) throw Errors.badRequest('Org unit not found');
    }
    await prisma.$transaction(async (tx) => {
      await tx.teamOrgUnit.deleteMany({ where: { teamId } });
      if (orgUnitId) await tx.teamOrgUnit.create({ data: { teamId, orgUnitId } });
    });
    await logActivity(prisma, {
      teamId,
      actorId,
      action: 'team.org_unit_set',
      meta: { orgUnitId },
    });
    return this.getTeamOrgUnit(teamId);
  }

  async setProjectOrgUnit(
    teamId: string,
    projectId: string,
    actorId: string,
    input: SetProjectOrgUnitBody,
  ): Promise<{ projectId: string; orgUnitId: string | null; orgUnitName: string | null }> {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, teamId: true },
    });
    if (!project || project.teamId !== teamId) throw Errors.notFound('Project not found');

    if (input.orgUnitId) {
      await this.getRow(input.orgUnitId);
    }

    const updated = await prisma.project.update({
      where: { id: projectId },
      data: { orgUnitId: input.orgUnitId },
      select: {
        id: true,
        orgUnitId: true,
        orgUnit: { select: { name: true } },
      },
    });
    await logActivity(prisma, {
      teamId,
      actorId,
      action: 'project.org_unit_set',
      meta: { projectId, orgUnitId: input.orgUnitId },
    });

    // v2.9 (Phase 5): standing policies fire when a project ENTERS an org
    // subtree — in this codebase the org attachment is the creation of that
    // relationship, so this is the plan's "applied once at project creation".
    // Applying is idempotent per (project, subject, level); detaching or
    // moving out of a subtree deliberately KEEPS previously-materialized
    // grants ("policy deletion never revokes" extends to moves — the
    // sourcePolicyId revoke script is the cleanup path when a move should
    // shed them).
    if (input.orgUnitId) {
      const applied = await applyOrgGrantPolicies(projectId, input.orgUnitId);
      if (applied > 0) {
        await logActivity(prisma, {
          teamId,
          actorId,
          action: 'project.org_policies_applied',
          meta: { projectId, orgUnitId: input.orgUnitId, applied },
        });
      }
    }

    return {
      projectId: updated.id,
      orgUnitId: updated.orgUnitId,
      orgUnitName: updated.orgUnit?.name ?? null,
    };
  }

  private async projectsInSubtree(root: OrgRow) {
    const ids = await this.descendantIds(root);
    return prisma.project.findMany({
      where: { orgUnitId: { in: ids } },
      select: {
        id: true,
        name: true,
        teamId: true,
        status: true,
        plannedBudget: true,
        budgetCurrency: true,
        ragStatus: true,
        team: { select: { name: true } },
        tasks: {
          where: { deletedAt: null },
          select: { status: true, dueDate: true },
        },
      },
    });
  }

  async reportSummary(orgUnitId: string) {
    const root = await this.getRow(orgUnitId);
    const projects = await this.projectsInSubtree(root);
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    let openTaskCount = 0;
    let overdueTaskCount = 0;
    for (const p of projects) {
      for (const t of p.tasks) {
        if (t.status === 'DONE') continue;
        openTaskCount++;
        if (t.dueDate && t.dueDate < todayStart) overdueTaskCount++;
      }
    }

    return {
      orgUnitId: root.id,
      orgUnitName: root.name,
      projectCount: projects.length,
      activeCount: projects.filter((p) => p.status === 'ACTIVE').length,
      onHoldCount: projects.filter((p) => p.status === 'ON_HOLD').length,
      archivedCount: projects.filter((p) => p.status === 'ARCHIVED').length,
      openTaskCount,
      overdueTaskCount,
    };
  }

  async reportProgress(orgUnitId: string) {
    const root = await this.getRow(orgUnitId);
    const projects = await this.projectsInSubtree(root);
    const projectRows = projects.map((p) => {
      const byStatus = { TODO: 0, IN_PROGRESS: 0, REVIEW: 0, DONE: 0 };
      for (const t of p.tasks) {
        if (t.status in byStatus) byStatus[t.status as keyof typeof byStatus]++;
      }
      const total = byStatus.TODO + byStatus.IN_PROGRESS + byStatus.REVIEW + byStatus.DONE;
      const percentComplete = total > 0 ? Math.round((byStatus.DONE / total) * 100) : 0;
      return {
        projectId: p.id,
        projectName: p.name,
        teamId: p.teamId,
        teamName: p.team.name,
        percentComplete,
      };
    });
    const avgPercentComplete =
      projectRows.length > 0
        ? Math.round(
            projectRows.reduce((sum, r) => sum + r.percentComplete, 0) / projectRows.length,
          )
        : 0;
    return {
      orgUnitId: root.id,
      orgUnitName: root.name,
      projectCount: projectRows.length,
      avgPercentComplete,
      projects: projectRows,
    };
  }

  async reportRag(orgUnitId: string) {
    const root = await this.getRow(orgUnitId);
    const projects = await this.projectsInSubtree(root);
    const byStatus = { GREEN: 0, AMBER: 0, RED: 0 };
    for (const p of projects) byStatus[p.ragStatus]++;
    return {
      orgUnitId: root.id,
      orgUnitName: root.name,
      projectCount: projects.length,
      byStatus,
    };
  }

  async reportCost(orgUnitId: string) {
    const root = await this.getRow(orgUnitId);
    const projects = await this.projectsInSubtree(root);
    const metrics = projects.map((p) => {
      const m = computeProjectBudgetMetrics(p.plannedBudget);
      return { currency: p.budgetCurrency, hasBudget: m.hasBudget, plannedBudget: m.plannedBudget };
    });
    return {
      orgUnitId: root.id,
      orgUnitName: root.name,
      projectCount: projects.length,
      rollupByCurrency: buildCurrencyRollups(metrics),
    };
  }

  reportEvm(orgUnitId: string) {
    return this.getRow(orgUnitId).then((root) => ({
      orgUnitId: root.id,
      orgUnitName: root.name,
      available: false as const,
      message: 'EVM roll-ups ship with the cost-control module (R7)',
    }));
  }

  async portfolioCsv(orgUnitId: string): Promise<string> {
    const progress = await this.reportProgress(orgUnitId);
    const lines = [
      'projectId,projectName,teamId,teamName,percentComplete',
      ...progress.projects.map(
        (p) =>
          `${p.projectId},"${p.projectName.replace(/"/g, '""')}",${p.teamId},"${p.teamName.replace(/"/g, '""')}",${p.percentComplete}`,
      ),
    ];
    return lines.join('\n');
  }
}

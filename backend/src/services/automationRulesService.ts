import { Prisma } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';
import type {
  CreateAutomationRuleBody,
  UpdateAutomationRuleBody,
} from '../schemas/automations.js';
import { logActivity } from './activityLogger.js';

export interface AutomationRuleView {
  id: string;
  teamId: string;
  name: string;
  description: string | null;
  enabled: boolean;
  triggerType: string;
  conditionMatch: string;
  position: number;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
  conditions: {
    id: string;
    factType: string;
    operator: string;
    valueJson: Prisma.JsonValue | null;
    customFieldId: string | null;
  }[];
  actions: {
    id: string;
    actionType: string;
    valueJson: Prisma.JsonValue | null;
    customFieldId: string | null;
    position: number;
  }[];
  lastRunStatus: string | null;
  lastRunAt: Date | null;
}

const RULE_INCLUDE = {
  conditions: true,
  actions: { orderBy: { position: 'asc' as const } },
} as const;

async function validateReferences(
  teamId: string,
  conditions: CreateAutomationRuleBody['conditions'],
  actions: CreateAutomationRuleBody['actions'],
): Promise<void> {
  const labelIds = new Set<string>();
  const fieldIds = new Set<string>();
  const userIds = new Set<string>();

  for (const c of conditions) {
    if (c.customFieldId) fieldIds.add(c.customFieldId);
    const v = c.valueJson as Record<string, unknown> | null | undefined;
    if (c.factType === 'label' && v?.labelId) labelIds.add(String(v.labelId));
    if (c.factType === 'assignee' && v?.userId) userIds.add(String(v.userId));
  }
  for (const a of actions) {
    if (a.customFieldId) fieldIds.add(a.customFieldId);
    const v = a.valueJson as Record<string, unknown> | null | undefined;
    if (a.actionType === 'add_label' || a.actionType === 'remove_label') {
      if (v?.labelId) labelIds.add(String(v.labelId));
    }
    if (a.actionType === 'set_assignee' && v?.userId) userIds.add(String(v.userId));
    if (a.actionType === 'send_notification' && v?.userId) userIds.add(String(v.userId));
  }

  for (const labelId of labelIds) {
    const label = await prisma.label.findUnique({ where: { id: labelId } });
    if (!label || label.teamId !== teamId) throw Errors.notFound('Label not found');
  }
  for (const fieldId of fieldIds) {
    const field = await prisma.customFieldDefinition.findUnique({ where: { id: fieldId } });
    if (!field || field.teamId !== teamId) throw Errors.notFound('Custom field not found');
  }
  for (const userId of userIds) {
    const m = await prisma.teamMembership.findUnique({
      where: { userId_teamId: { userId, teamId } },
    });
    if (!m) throw Errors.badRequest('User must be a team member');
  }
}

function toView(
  row: Prisma.AutomationRuleGetPayload<{ include: typeof RULE_INCLUDE }>,
  lastRun: { status: string; createdAt: Date } | null,
): AutomationRuleView {
  return {
    id: row.id,
    teamId: row.teamId,
    name: row.name,
    description: row.description,
    enabled: row.enabled,
    triggerType: row.triggerType,
    conditionMatch: row.conditionMatch,
    position: row.position,
    createdById: row.createdById,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    conditions: row.conditions.map((c) => ({
      id: c.id,
      factType: c.factType,
      operator: c.operator,
      valueJson: c.valueJson,
      customFieldId: c.customFieldId,
    })),
    actions: row.actions.map((a) => ({
      id: a.id,
      actionType: a.actionType,
      valueJson: a.valueJson,
      customFieldId: a.customFieldId,
      position: a.position,
    })),
    lastRunStatus: lastRun?.status ?? null,
    lastRunAt: lastRun?.createdAt ?? null,
  };
}

async function lastRunForRule(ruleId: string) {
  return prisma.automationRun.findFirst({
    where: { ruleId },
    orderBy: { createdAt: 'desc' },
    select: { status: true, createdAt: true },
  });
}

export class AutomationRulesService {
  async list(teamId: string): Promise<AutomationRuleView[]> {
    const rows = await prisma.automationRule.findMany({
      where: { teamId },
      orderBy: { position: 'asc' },
      include: RULE_INCLUDE,
    });
    const views: AutomationRuleView[] = [];
    for (const row of rows) {
      views.push(toView(row, await lastRunForRule(row.id)));
    }
    return views;
  }

  async get(teamId: string, ruleId: string): Promise<AutomationRuleView> {
    const row = await prisma.automationRule.findUnique({
      where: { id: ruleId },
      include: RULE_INCLUDE,
    });
    if (!row || row.teamId !== teamId) throw Errors.notFound('Automation rule not found');
    return toView(row, await lastRunForRule(ruleId));
  }

  async create(
    teamId: string,
    actorId: string,
    input: CreateAutomationRuleBody,
  ): Promise<AutomationRuleView> {
    await validateReferences(teamId, input.conditions, input.actions);
    const maxPos = await prisma.automationRule.aggregate({
      where: { teamId },
      _max: { position: true },
    });
    const position = input.position ?? (maxPos._max.position ?? -1) + 1;

    const row = await prisma.$transaction(async (tx) => {
      const rule = await tx.automationRule.create({
        data: {
          teamId,
          name: input.name,
          description: input.description ?? null,
          enabled: input.enabled ?? true,
          triggerType: input.triggerType,
          conditionMatch: input.conditionMatch ?? 'ALL',
          position,
          createdById: actorId,
          conditions: {
            create: input.conditions.map((c) => ({
              factType: c.factType,
              operator: c.operator,
              valueJson: c.valueJson ?? Prisma.JsonNull,
              customFieldId: c.customFieldId ?? null,
            })),
          },
          actions: {
            create: input.actions.map((a, i) => ({
              actionType: a.actionType,
              valueJson: a.valueJson ?? Prisma.JsonNull,
              customFieldId: a.customFieldId ?? null,
              position: a.position ?? i,
            })),
          },
        },
        include: RULE_INCLUDE,
      });
      await logActivity(tx, {
        teamId,
        actorId,
        action: 'automation.rule_created',
        meta: { ruleId: rule.id, name: rule.name },
      });
      return rule;
    });
    return toView(row, null);
  }

  async update(
    teamId: string,
    ruleId: string,
    actorId: string,
    input: UpdateAutomationRuleBody,
  ): Promise<AutomationRuleView> {
    const existing = await prisma.automationRule.findUnique({ where: { id: ruleId } });
    if (!existing || existing.teamId !== teamId) throw Errors.notFound('Automation rule not found');

    if (input.conditions !== undefined && input.actions !== undefined) {
      await validateReferences(teamId, input.conditions, input.actions);
    } else if (input.conditions !== undefined) {
      const actions = (
        await prisma.automationAction.findMany({ where: { ruleId } })
      ).map((a) => ({
        actionType: a.actionType as never,
        valueJson: a.valueJson as Record<string, unknown> | null,
        customFieldId: a.customFieldId,
      }));
      await validateReferences(teamId, input.conditions, actions as CreateAutomationRuleBody['actions']);
    } else if (input.actions !== undefined) {
      const conditions = (
        await prisma.automationCondition.findMany({ where: { ruleId } })
      ).map((c) => ({
        factType: c.factType as never,
        operator: c.operator as never,
        valueJson: c.valueJson as Record<string, unknown> | null,
        customFieldId: c.customFieldId,
      }));
      await validateReferences(teamId, conditions as CreateAutomationRuleBody['conditions'], input.actions);
    }

    const row = await prisma.$transaction(async (tx) => {
      if (input.conditions !== undefined) {
        await tx.automationCondition.deleteMany({ where: { ruleId } });
      }
      if (input.actions !== undefined) {
        await tx.automationAction.deleteMany({ where: { ruleId } });
      }
      const rule = await tx.automationRule.update({
        where: { id: ruleId },
        data: {
          ...(input.name !== undefined && { name: input.name }),
          ...(input.description !== undefined && { description: input.description }),
          ...(input.enabled !== undefined && { enabled: input.enabled }),
          ...(input.triggerType !== undefined && { triggerType: input.triggerType }),
          ...(input.conditionMatch !== undefined && { conditionMatch: input.conditionMatch }),
          ...(input.position !== undefined && { position: input.position }),
          ...(input.conditions !== undefined && {
            conditions: {
              create: input.conditions.map((c) => ({
                factType: c.factType,
                operator: c.operator,
                valueJson: c.valueJson ?? Prisma.JsonNull,
                customFieldId: c.customFieldId ?? null,
              })),
            },
          }),
          ...(input.actions !== undefined && {
            actions: {
              create: input.actions.map((a, i) => ({
                actionType: a.actionType,
                valueJson: a.valueJson ?? Prisma.JsonNull,
                customFieldId: a.customFieldId ?? null,
                position: a.position ?? i,
              })),
            },
          }),
        },
        include: RULE_INCLUDE,
      });
      await logActivity(tx, {
        teamId,
        actorId,
        action: 'automation.rule_updated',
        meta: { ruleId, name: rule.name },
      });
      return rule;
    });
    return toView(row, await lastRunForRule(ruleId));
  }

  async remove(teamId: string, ruleId: string, actorId: string): Promise<void> {
    const existing = await prisma.automationRule.findUnique({ where: { id: ruleId } });
    if (!existing || existing.teamId !== teamId) throw Errors.notFound('Automation rule not found');
    await prisma.$transaction(async (tx) => {
      await tx.automationRule.delete({ where: { id: ruleId } });
      await logActivity(tx, {
        teamId,
        actorId,
        action: 'automation.rule_deleted',
        meta: { ruleId, name: existing.name },
      });
    });
  }

  async reorder(teamId: string, actorId: string, orderedIds: string[]): Promise<AutomationRuleView[]> {
    const rules = await prisma.automationRule.findMany({ where: { teamId } });
    const idSet = new Set(rules.map((r) => r.id));
    if (orderedIds.some((id) => !idSet.has(id)) || orderedIds.length !== rules.length) {
      throw Errors.badRequest('orderedIds must list every rule in this team exactly once');
    }
    await prisma.$transaction(
      orderedIds.map((id, position) =>
        prisma.automationRule.update({ where: { id }, data: { position } }),
      ),
    );
    await logActivity(prisma, {
      teamId,
      actorId,
      action: 'automation.rules_reordered',
      meta: { count: orderedIds.length },
    });
    return this.list(teamId);
  }

  async listRuns(
    teamId: string,
    ruleId: string,
    page: number,
    pageSize: number,
  ): Promise<{
    items: { id: string; ruleId: string; taskId: string; triggerType: string; status: string; detail: string | null; createdAt: Date }[];
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  }> {
    const rule = await prisma.automationRule.findUnique({ where: { id: ruleId } });
    if (!rule || rule.teamId !== teamId) throw Errors.notFound('Automation rule not found');

    const totalItems = await prisma.automationRun.count({ where: { ruleId } });
    const totalPages = Math.ceil(totalItems / pageSize);
    const items = await prisma.automationRun.findMany({
      where: { ruleId },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return { items, page, pageSize, totalItems, totalPages };
  }
}

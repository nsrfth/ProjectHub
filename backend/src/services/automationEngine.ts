import type { Prisma, TaskPriority, TaskStatus } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';
import {
  automationStore,
  childContext,
  createRootContext,
  getActiveContext,
  MAX_AUTOMATION_DEPTH,
  ruleFireKey,
  type AutomationExecutionContext,
} from '../lib/automationContext.js';
import { getSystemUserId } from '../lib/systemUser.js';
import type { AutomationTriggerType } from '../schemas/automations.js';
import { logActivity } from './activityLogger.js';
import { CustomFieldsService } from './customFieldsService.js';
import { LabelsService } from './labelsService.js';
import { notificationsHub } from './notificationsHub.js';
import type { TaskView } from './tasksService.js';

export interface AutomationEventPayload {
  teamId: string;
  projectId: string;
  taskId: string;
  triggerType: AutomationTriggerType;
  task?: TaskView;
  fromStatus?: TaskStatus;
  toStatus?: TaskStatus;
  changedFields?: string[];
  customFieldId?: string;
  customFieldName?: string;
  customFieldCleared?: boolean;
}

type RuleRow = Prisma.AutomationRuleGetPayload<{
  include: { conditions: true; actions: { orderBy: { position: 'asc' } } };
}>;

const _labels = new LabelsService();
const _customFields = new CustomFieldsService();

async function systemActorId(): Promise<string> {
  const id = await getSystemUserId();
  if (!id) throw Errors.internal('System user not configured');
  return id;
}

async function loadFreshTask(teamId: string, projectId: string, taskId: string): Promise<TaskView> {
  const { TasksService } = await import('./tasksService.js');
  const svc = new TasksService();
  return svc.get(teamId, projectId, taskId);
}

function expandTemplate(text: string, task: TaskView): string {
  return text
    .replace(/\{\{task\.title\}\}/g, task.title)
    .replace(/\{\{task\.status\}\}/g, task.status)
    .replace(/\{\{task\.priority\}\}/g, task.priority);
}

async function logRun(
  ruleId: string,
  taskId: string,
  triggerType: string,
  status: 'SUCCESS' | 'SKIPPED' | 'ERROR',
  detail: string | null,
): Promise<void> {
  try {
    await prisma.automationRun.create({
      data: { ruleId, taskId, triggerType, status, detail },
    });
  } catch {
    // Best-effort audit — never fail the parent path.
  }
}

function evaluateCondition(
  cond: RuleRow['conditions'][number],
  task: TaskView,
  event: AutomationEventPayload,
): boolean {
  const v = cond.valueJson as Record<string, unknown> | null;

  switch (cond.factType) {
    case 'status': {
      if (cond.operator === 'is') return task.status === v?.status;
      if (cond.operator === 'is_not') return task.status !== v?.status;
      return false;
    }
    case 'priority': {
      if (cond.operator === 'is') return task.priority === v?.priority;
      if (cond.operator === 'is_not') return task.priority !== v?.priority;
      return false;
    }
    case 'assignee': {
      if (cond.operator === 'is_empty') return task.assigneeId === null;
      if (cond.operator === 'is') return task.assigneeId === v?.userId;
      if (cond.operator === 'is_not') return task.assigneeId !== v?.userId;
      return false;
    }
    case 'label': {
      const labelId = v?.labelId as string | undefined;
      const has = labelId ? task.labels.some((l) => l.id === labelId) : false;
      if (cond.operator === 'has') return has;
      if (cond.operator === 'not_has') return !has;
      return false;
    }
    case 'due_date': {
      const now = Date.now();
      const due = task.dueDate ? new Date(task.dueDate).getTime() : null;
      if (cond.operator === 'is_empty') return due === null;
      if (cond.operator === 'is_overdue') {
        return due !== null && due < now && task.status !== 'DONE';
      }
      if (cond.operator === 'within_days') {
        const days = Number(v?.days ?? 0);
        if (due === null || !Number.isFinite(days)) return false;
        const limit = now + days * 86_400_000;
        return due >= now && due <= limit;
      }
      return false;
    }
    case 'custom_field': {
      const field = task.customFields.find((f) => f.fieldId === cond.customFieldId);
      const empty =
        !field
        || (field.valueText === null
          && field.valueNumber === null
          && field.valueDate === null
          && field.valueBool === null
          && field.valueUserId === null
          && field.optionIds.length === 0);
      if (cond.operator === 'is_empty') return empty;
      if (!field || empty) return cond.operator === 'not_equals';

      const op = cond.operator;
      const expected = v ?? {};

      if (field.fieldType === 'TEXT') {
        if (op === 'equals') return field.valueText === expected.text;
        if (op === 'not_equals') return field.valueText !== expected.text;
      }
      if (field.fieldType === 'NUMBER') {
        const n = field.valueNumber === null ? null : Number(field.valueNumber);
        const exp = expected.number === undefined ? null : Number(expected.number);
        if (n === null || exp === null || !Number.isFinite(n) || !Number.isFinite(exp)) return false;
        if (op === 'equals') return n === exp;
        if (op === 'not_equals') return n !== exp;
        if (op === 'lt') return n < exp;
        if (op === 'gt') return n > exp;
      }
      if (field.fieldType === 'DATE') {
        const d = field.valueDate ? new Date(field.valueDate).getTime() : null;
        const exp = expected.date ? new Date(String(expected.date)).getTime() : null;
        if (d === null || exp === null) return false;
        if (op === 'equals') return d === exp;
        if (op === 'not_equals') return d !== exp;
        if (op === 'lt') return d < exp;
        if (op === 'gt') return d > exp;
      }
      if (field.fieldType === 'CHECKBOX') {
        if (op === 'equals') return field.valueBool === expected.bool;
        if (op === 'not_equals') return field.valueBool !== expected.bool;
      }
      if (field.fieldType === 'PERSON') {
        if (op === 'equals') return field.valueUserId === expected.userId;
        if (op === 'not_equals') return field.valueUserId !== expected.userId;
      }
      if (field.fieldType === 'SINGLE_SELECT') {
        const opt = expected.optionId as string | undefined;
        if (op === 'equals') return field.optionIds.includes(opt ?? '');
        if (op === 'not_equals') return !field.optionIds.includes(opt ?? '');
      }
      if (field.fieldType === 'MULTI_SELECT') {
        const opts = (expected.optionIds as string[] | undefined) ?? [];
        if (op === 'equals') {
          return opts.length === field.optionIds.length && opts.every((o) => field.optionIds.includes(o));
        }
        if (op === 'not_equals') return !opts.every((o) => field.optionIds.includes(o));
      }
      return false;
    }
    default:
      return false;
  }
}

function evaluateRuleConditions(rule: RuleRow, task: TaskView, event: AutomationEventPayload): boolean {
  if (rule.conditions.length === 0) return true;
  const results = rule.conditions.map((c) => evaluateCondition(c, task, event));
  return rule.conditionMatch === 'ANY' ? results.some(Boolean) : results.every(Boolean);
}

async function executeAction(
  action: RuleRow['actions'][number],
  teamId: string,
  projectId: string,
  task: TaskView,
  actorId: string,
): Promise<void> {
  const v = action.valueJson as Record<string, unknown> | null;
  const { TasksService } = await import('./tasksService.js');
  const tasksSvc = new TasksService();

  switch (action.actionType) {
    case 'set_status': {
      const status = v?.status as TaskStatus;
      // v2.5.58: transitions into ON_HOLD / DONE require a status comment;
      // rules have no human to ask, so stamp a standard automation note.
      await tasksSvc.update(teamId, projectId, task.id, actorId, 'MANAGER', 'ADMIN', {
        status,
        statusComment: `Status set to ${status} by an automation rule.`,
      });
      return;
    }
    case 'set_priority': {
      const priority = v?.priority as TaskPriority;
      await tasksSvc.update(teamId, projectId, task.id, actorId, 'MANAGER', 'ADMIN', { priority });
      return;
    }
    case 'set_assignee': {
      const assigneeId = (v?.userId as string | null | undefined) ?? null;
      await tasksSvc.update(teamId, projectId, task.id, actorId, 'MANAGER', 'ADMIN', { assigneeId });
      return;
    }
    case 'add_label': {
      await _labels.attach(teamId, task.id, v?.labelId as string);
      return;
    }
    case 'remove_label': {
      await _labels.detach(teamId, task.id, v?.labelId as string);
      return;
    }
    case 'set_custom_field': {
      const fieldId = action.customFieldId ?? (v?.fieldId as string | undefined);
      if (!fieldId) throw Errors.badRequest('set_custom_field requires customFieldId');
      await _customFields.setTaskValue(teamId, projectId, task.id, fieldId, actorId, v as never);
      return;
    }
    case 'add_comment': {
      const body = expandTemplate(String(v?.text ?? ''), task);
      const { CommentsService } = await import('./commentsService.js');
      await new CommentsService().create(task.id, actorId, 'ADMIN', body);
      return;
    }
    case 'send_notification': {
      const target = v?.target as string;
      let recipients: string[] = [];
      if (target === 'assignee' && task.assigneeId) {
        recipients = [task.assigneeId];
      } else if (target === 'user' && typeof v?.userId === 'string') {
        recipients = [v.userId as string];
      } else if (target === 'role') {
        const role = v?.role === 'MANAGER' ? 'MANAGER' : 'MEMBER';
        const members = await prisma.teamMembership.findMany({
          where: { teamId, role },
          select: { userId: true },
        });
        recipients = members.map((m) => m.userId);
      }
      if (recipients.length === 0) return;
      const message = String(v?.message ?? 'Automation notification');
      await prisma.notification.createMany({
        data: recipients
          .filter((id) => id !== actorId)
          .map((userId) => ({
            userId,
            teamId,
            type: 'TASK_COMMENT' as const,
            payload: {
              taskId: task.id,
              projectId,
              taskTitle: task.title,
              excerpt: message,
              automation: true,
            },
          })),
      });
      for (const userId of recipients) {
        if (userId !== actorId) {
          notificationsHub.publish(userId, { type: 'notification:new', id: '' });
        }
      }
      return;
    }
    default:
      throw Errors.badRequest(`Unknown action type: ${action.actionType}`);
  }
}

async function runRule(
  rule: RuleRow,
  event: AutomationEventPayload,
  ctx: AutomationExecutionContext,
): Promise<void> {
  const key = ruleFireKey(rule.id, event.taskId);
  if (ctx.firedRules.has(key)) {
    await logRun(rule.id, event.taskId, event.triggerType, 'SKIPPED', 'Rule already fired in this chain');
    return;
  }

  const task = await loadFreshTask(event.teamId, event.projectId, event.taskId);

  if (!evaluateRuleConditions(rule, task, event)) {
    await logRun(rule.id, event.taskId, event.triggerType, 'SKIPPED', 'Conditions not matched');
    return;
  }

  ctx.firedRules.add(key);
  const actorId = await systemActorId();
  const errors: string[] = [];

  for (const action of rule.actions) {
    try {
      await automationStore.run(ctx, async () => {
        await executeAction(action, event.teamId, event.projectId, task, actorId);
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${action.actionType}: ${msg}`);
      await logRun(rule.id, event.taskId, event.triggerType, 'ERROR', msg);
      // Policy: continue remaining actions after an isolated failure.
    }
  }

  if (errors.length === 0) {
    await logRun(rule.id, event.taskId, event.triggerType, 'SUCCESS', `Executed ${rule.actions.length} action(s)`);
    await logActivity(prisma, {
      teamId: event.teamId,
      taskId: event.taskId,
      actorId,
      action: 'automation.rule_fired',
      meta: { ruleId: rule.id, ruleName: rule.name, triggerType: event.triggerType },
    });
  }
}

async function runRulesForTrigger(
  event: AutomationEventPayload,
  ctx: AutomationExecutionContext,
): Promise<void> {
  if (ctx.depth >= MAX_AUTOMATION_DEPTH) {
    const anyRule = await prisma.automationRule.findFirst({
      where: { teamId: event.teamId, enabled: true, triggerType: event.triggerType },
      select: { id: true },
    });
    if (anyRule) {
      await logRun(anyRule.id, event.taskId, event.triggerType, 'ERROR', `Loop guard: max depth ${MAX_AUTOMATION_DEPTH} exceeded`);
    }
    return;
  }

  const rules = await prisma.automationRule.findMany({
    where: { teamId: event.teamId, enabled: true, triggerType: event.triggerType },
    orderBy: { position: 'asc' },
    include: {
      conditions: true,
      actions: { orderBy: { position: 'asc' } },
    },
  });

  for (const rule of rules) {
    try {
      await runRule(rule, event, ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logRun(rule.id, event.taskId, event.triggerType, 'ERROR', msg);
    }
  }
}

export async function emitAutomationForTask(event: AutomationEventPayload): Promise<void> {
  const parent = getActiveContext();
  if (parent) {
    await dispatchAutomationEventNested(event);
  } else {
    await dispatchAutomationEvent(event, createRootContext());
  }
}

/** Post-commit entry point — never throws to caller. */
export async function dispatchAutomationEvent(
  event: AutomationEventPayload,
  parentCtx?: AutomationExecutionContext,
): Promise<void> {
  try {
    const ctx = parentCtx ?? getActiveContext() ?? createRootContext();
    const runCtx = parentCtx ? ctx : ctx;
    await runRulesForTrigger(event, runCtx);
  } catch {
    // Best-effort — mirror webhook emit policy.
  }
}

/** Called from nested post-commit when an action caused a new task event. */
export async function dispatchAutomationEventNested(
  event: AutomationEventPayload,
): Promise<void> {
  const parent = getActiveContext();
  if (!parent) {
    await dispatchAutomationEvent(event);
    return;
  }
  const nested = childContext(parent);
  await automationStore.run(nested, () => dispatchAutomationEvent(event, nested));
}

export { MAX_AUTOMATION_DEPTH };

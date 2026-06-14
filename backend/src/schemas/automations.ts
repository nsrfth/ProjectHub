import { z } from 'zod';
import { taskPriorityEnum, taskStatusEnum } from './tasks.js';

export const automationTriggerEnum = z.enum([
  'task.created',
  'task.status_changed',
  'task.updated',
  'task.assigned',
  'task.custom_field_changed',
]);

export const conditionMatchEnum = z.enum(['ALL', 'ANY']);

export const conditionFactEnum = z.enum([
  'status',
  'priority',
  'assignee',
  'label',
  'due_date',
  'custom_field',
]);

export const conditionOperatorEnum = z.enum([
  'is',
  'is_not',
  'is_empty',
  'has',
  'not_has',
  'is_overdue',
  'within_days',
  'equals',
  'not_equals',
  'lt',
  'gt',
]);

export const actionTypeEnum = z.enum([
  'set_status',
  'set_priority',
  'set_assignee',
  'add_label',
  'remove_label',
  'set_custom_field',
  'add_comment',
  'send_notification',
]);

const automationConditionInput = z.object({
  factType: conditionFactEnum,
  operator: conditionOperatorEnum,
  valueJson: z.record(z.unknown()).nullable().optional(),
  customFieldId: z.string().nullable().optional(),
});

const automationActionInput = z.object({
  actionType: actionTypeEnum,
  valueJson: z.record(z.unknown()).nullable().optional(),
  customFieldId: z.string().nullable().optional(),
  position: z.number().int().nonnegative().optional(),
});

export const createAutomationRuleBody = z.object({
  name: z.string().min(1).max(120).trim(),
  description: z.string().max(2000).trim().nullable().optional(),
  enabled: z.boolean().optional(),
  triggerType: automationTriggerEnum,
  conditionMatch: conditionMatchEnum.optional(),
  position: z.number().int().nonnegative().optional(),
  conditions: z.array(automationConditionInput).default([]),
  actions: z.array(automationActionInput).min(1),
});

export const updateAutomationRuleBody = z
  .object({
    name: z.string().min(1).max(120).trim().optional(),
    description: z.string().max(2000).trim().nullable().optional(),
    enabled: z.boolean().optional(),
    triggerType: automationTriggerEnum.optional(),
    conditionMatch: conditionMatchEnum.optional(),
    position: z.number().int().nonnegative().optional(),
    conditions: z.array(automationConditionInput).optional(),
    actions: z.array(automationActionInput).min(1).optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined
      || v.description !== undefined
      || v.enabled !== undefined
      || v.triggerType !== undefined
      || v.conditionMatch !== undefined
      || v.position !== undefined
      || v.conditions !== undefined
      || v.actions !== undefined,
    'Provide at least one field to update',
  );

export const reorderAutomationsBody = z.object({
  orderedIds: z.array(z.string().min(1)).min(1),
});

export const listAutomationRunsQuery = z.object({
  page: z.coerce.number().int().transform((p) => Math.max(1, p)).default(1),
  pageSize: z.coerce.number().int().transform((p) => Math.min(100, Math.max(10, p || 25))).default(25),
});

export const automationConditionResponse = z.object({
  id: z.string(),
  factType: conditionFactEnum,
  operator: conditionOperatorEnum,
  valueJson: z.record(z.unknown()).nullable(),
  customFieldId: z.string().nullable(),
});

export const automationActionResponse = z.object({
  id: z.string(),
  actionType: actionTypeEnum,
  valueJson: z.record(z.unknown()).nullable(),
  customFieldId: z.string().nullable(),
  position: z.number().int(),
});

export const automationRuleResponse = z.object({
  id: z.string(),
  teamId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  enabled: z.boolean(),
  triggerType: automationTriggerEnum,
  conditionMatch: conditionMatchEnum,
  position: z.number().int(),
  createdById: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  conditions: z.array(automationConditionResponse),
  actions: z.array(automationActionResponse),
  lastRunStatus: z.string().nullable().optional(),
  lastRunAt: z.string().nullable().optional(),
});

export const automationRunResponse = z.object({
  id: z.string(),
  ruleId: z.string(),
  taskId: z.string(),
  triggerType: z.string(),
  status: z.enum(['SUCCESS', 'SKIPPED', 'ERROR']),
  detail: z.string().nullable(),
  createdAt: z.string(),
});

export const automationRunsPageResponse = z.object({
  items: z.array(automationRunResponse),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  totalItems: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative(),
});

export type CreateAutomationRuleBody = z.infer<typeof createAutomationRuleBody>;
export type UpdateAutomationRuleBody = z.infer<typeof updateAutomationRuleBody>;
export type AutomationTriggerType = z.infer<typeof automationTriggerEnum>;

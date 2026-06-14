import { api } from '@/lib/api';

export type AutomationTrigger =
  | 'task.created'
  | 'task.status_changed'
  | 'task.updated'
  | 'task.assigned'
  | 'task.custom_field_changed';

export type ConditionMatch = 'ALL' | 'ANY';

export interface AutomationCondition {
  id: string;
  factType: string;
  operator: string;
  valueJson: Record<string, unknown> | null;
  customFieldId: string | null;
}

export interface AutomationAction {
  id: string;
  actionType: string;
  valueJson: Record<string, unknown> | null;
  customFieldId: string | null;
  position: number;
}

export interface AutomationRule {
  id: string;
  teamId: string;
  name: string;
  description: string | null;
  enabled: boolean;
  triggerType: AutomationTrigger;
  conditionMatch: ConditionMatch;
  position: number;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
  conditions: AutomationCondition[];
  actions: AutomationAction[];
  lastRunStatus: string | null;
  lastRunAt: string | null;
}

export interface AutomationRun {
  id: string;
  ruleId: string;
  taskId: string;
  triggerType: string;
  status: 'SUCCESS' | 'SKIPPED' | 'ERROR';
  detail: string | null;
  createdAt: string;
}

export interface PagedRuns {
  items: AutomationRun[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export type ConditionInput = {
  factType: string;
  operator: string;
  valueJson?: Record<string, unknown> | null;
  customFieldId?: string | null;
};

export type ActionInput = {
  actionType: string;
  valueJson?: Record<string, unknown> | null;
  customFieldId?: string | null;
  position?: number;
};

export async function listRules(teamId: string): Promise<AutomationRule[]> {
  return (await api.get<AutomationRule[]>(`/teams/${teamId}/automations`)).data;
}

export async function createRule(
  teamId: string,
  input: {
    name: string;
    description?: string | null;
    enabled?: boolean;
    triggerType: AutomationTrigger;
    conditionMatch?: ConditionMatch;
    position?: number;
    conditions?: ConditionInput[];
    actions: ActionInput[];
  },
): Promise<AutomationRule> {
  return (await api.post<AutomationRule>(`/teams/${teamId}/automations`, input)).data;
}

export async function updateRule(
  teamId: string,
  ruleId: string,
  input: Partial<{
    name: string;
    description: string | null;
    enabled: boolean;
    triggerType: AutomationTrigger;
    conditionMatch: ConditionMatch;
    position: number;
    conditions: ConditionInput[];
    actions: ActionInput[];
  }>,
): Promise<AutomationRule> {
  return (await api.patch<AutomationRule>(`/teams/${teamId}/automations/${ruleId}`, input)).data;
}

export async function deleteRule(teamId: string, ruleId: string): Promise<void> {
  await api.delete(`/teams/${teamId}/automations/${ruleId}`);
}

export async function reorderRules(teamId: string, orderedIds: string[]): Promise<AutomationRule[]> {
  return (await api.patch<AutomationRule[]>(`/teams/${teamId}/automations/reorder`, { orderedIds })).data;
}

export async function listRuns(teamId: string, ruleId: string, page = 1): Promise<PagedRuns> {
  return (
    await api.get<PagedRuns>(`/teams/${teamId}/automations/${ruleId}/runs`, { params: { page } })
  ).data;
}

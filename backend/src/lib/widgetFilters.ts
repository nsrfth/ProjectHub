import type { Prisma, TaskPriority, TaskStatus } from '@prisma/client';
import type { WidgetFilterCondition, WidgetFilters } from '../schemas/dashboards.js';

const OPEN_STATUSES: TaskStatus[] = ['TODO', 'IN_PROGRESS', 'ON_HOLD', 'REVIEW', 'PENDING_APPROVAL'];

export function parseGroupBy(groupBy: string | null | undefined): {
  kind: 'builtin';
  dimension: string;
} | {
  kind: 'custom_field';
  fieldId: string;
} | null {
  if (!groupBy) return null;
  if (groupBy.startsWith('custom_field:')) {
    return { kind: 'custom_field', fieldId: groupBy.slice('custom_field:'.length) };
  }
  return { kind: 'builtin', dimension: groupBy };
}

export function buildTaskWhereFromFilters(
  teamId: string,
  filters: WidgetFilters | null | undefined,
): Prisma.TaskWhereInput {
  const base: Prisma.TaskWhereInput = {
    teamId,
    deletedAt: null,
  };

  if (!filters?.conditions?.length) {
    return base;
  }

  const clauses: Prisma.TaskWhereInput[] = [];
  for (const cond of filters.conditions) {
    const clause = conditionToWhere(cond);
    if (clause) clauses.push(clause);
  }

  if (clauses.length === 0) return base;

  if (filters.match === 'ANY') {
    return { ...base, OR: clauses };
  }
  return { ...base, AND: clauses };
}

function conditionToWhere(cond: WidgetFilterCondition): Prisma.TaskWhereInput | null {
  switch (cond.field) {
    case 'status': {
      if (cond.op !== 'in' || !Array.isArray(cond.value)) return null;
      return { status: { in: cond.value as TaskStatus[] } };
    }
    case 'priority': {
      if (cond.op !== 'in' || !Array.isArray(cond.value)) return null;
      return { priority: { in: cond.value as TaskPriority[] } };
    }
    case 'assignee': {
      if (cond.op !== 'in' || !Array.isArray(cond.value)) return null;
      const ids = cond.value as string[];
      const hasNull = ids.includes('__unassigned__');
      const realIds = ids.filter((id) => id !== '__unassigned__');
      if (hasNull && realIds.length) {
        return { OR: [{ assigneeId: null }, { assigneeId: { in: realIds } }] };
      }
      if (hasNull) return { assigneeId: null };
      return { assigneeId: { in: realIds } };
    }
    case 'label': {
      if (cond.op !== 'has') return null;
      const labelId = Array.isArray(cond.value) ? cond.value[0] : cond.value;
      if (typeof labelId !== 'string') return null;
      return { labels: { some: { labelId } } };
    }
    case 'project': {
      if (cond.op !== 'in' || !Array.isArray(cond.value)) return null;
      return { projectId: { in: cond.value as string[] } };
    }
    case 'custom_field': {
      if (!cond.customFieldId) return null;
      const fieldId = cond.customFieldId;
      if (cond.op === 'equals') {
        if (typeof cond.value === 'string') {
          return {
            customFieldValues: {
              some: {
                fieldId,
                OR: [
                  { valueText: cond.value },
                  { selections: { some: { optionId: cond.value } } },
                ],
              },
            },
          };
        }
        if (typeof cond.value === 'number') {
          return {
            customFieldValues: {
              some: { fieldId, valueNumber: cond.value },
            },
          };
        }
        if (typeof cond.value === 'boolean') {
          return {
            customFieldValues: {
              some: { fieldId, valueBool: cond.value },
            },
          };
        }
      }
      return null;
    }
    default:
      return null;
  }
}

export { OPEN_STATUSES };

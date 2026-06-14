import { Prisma, type CustomFieldType } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';
import { logActivity } from './activityLogger.js';
import type {
  CreateCustomFieldBody,
  SetCustomFieldOptionsBody,
  SetTaskCustomFieldValueBody,
  UpdateCustomFieldBody,
} from '../schemas/customFields.js';

const SELECT_TYPES = new Set<CustomFieldType>(['SINGLE_SELECT', 'MULTI_SELECT']);

export interface CustomFieldOptionView {
  id: string;
  label: string;
  color: string | null;
  position: number;
}

export interface CustomFieldDefinitionView {
  id: string;
  teamId: string;
  name: string;
  type: CustomFieldType;
  description: string | null;
  position: number;
  required: boolean;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
  options: CustomFieldOptionView[];
}

export interface TaskCustomFieldValueView {
  fieldId: string;
  fieldName: string;
  fieldType: CustomFieldType;
  required: boolean;
  active: boolean;
  valueText: string | null;
  valueNumber: string | null;
  valueDate: string | null;
  valueBool: boolean | null;
  valueUserId: string | null;
  valueUserName: string | null;
  optionIds: string[];
  optionLabels: string[];
}

const DEFINITION_INCLUDE = {
  options: { orderBy: { position: 'asc' as const } },
} as const;

function toDefinitionView(
  row: Prisma.CustomFieldDefinitionGetPayload<{ include: typeof DEFINITION_INCLUDE }>,
): CustomFieldDefinitionView {
  return {
    id: row.id,
    teamId: row.teamId,
    name: row.name,
    type: row.type,
    description: row.description,
    position: row.position,
    required: row.required,
    active: row.active,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    options: row.options.map((o) => ({
      id: o.id,
      label: o.label,
      color: o.color,
      position: o.position,
    })),
  };
}

function normaliseNumber(input: number | string): Prisma.Decimal {
  const s = typeof input === 'number' ? String(input) : input.trim();
  return new Prisma.Decimal(s);
}

function isEmptyValue(type: CustomFieldType, input: SetTaskCustomFieldValueBody): boolean {
  switch (type) {
    case 'TEXT':
      return input.valueText === null || input.valueText === undefined || input.valueText.trim() === '';
    case 'NUMBER':
      return input.valueNumber === null || input.valueNumber === undefined;
    case 'DATE':
      return input.valueDate === null || input.valueDate === undefined;
    case 'CHECKBOX':
      return input.valueBool === null || input.valueBool === undefined;
    case 'PERSON':
      return input.valueUserId === null || input.valueUserId === undefined;
    case 'SINGLE_SELECT':
    case 'MULTI_SELECT':
      return !input.optionIds || input.optionIds.length === 0;
    default:
      return true;
  }
}

function summariseValue(
  type: CustomFieldType,
  data: {
    valueText: string | null;
    valueNumber: Prisma.Decimal | null;
    valueDate: Date | null;
    valueBool: boolean | null;
    valueUserName: string | null;
    optionLabels: string[];
  },
): string {
  switch (type) {
    case 'TEXT':
      if (!data.valueText) return '(empty)';
      return data.valueText.length > 50 ? `${data.valueText.slice(0, 50)}…` : data.valueText;
    case 'NUMBER':
      return data.valueNumber === null ? '(empty)' : data.valueNumber.toString();
    case 'DATE':
      return data.valueDate === null ? '(empty)' : data.valueDate.toISOString().slice(0, 10);
    case 'CHECKBOX':
      return data.valueBool === null ? '(empty)' : data.valueBool ? 'true' : 'false';
    case 'PERSON':
      return data.valueUserName ?? '(empty)';
    case 'SINGLE_SELECT':
    case 'MULTI_SELECT':
      return data.optionLabels.length ? data.optionLabels.join(', ') : '(empty)';
    default:
      return '(empty)';
  }
}

export class CustomFieldsService {
  async listDefinitions(teamId: string): Promise<CustomFieldDefinitionView[]> {
    const rows = await prisma.customFieldDefinition.findMany({
      where: { teamId },
      include: DEFINITION_INCLUDE,
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
    });
    return rows.map(toDefinitionView);
  }

  async getDefinition(teamId: string, fieldId: string): Promise<CustomFieldDefinitionView> {
    const row = await prisma.customFieldDefinition.findUnique({
      where: { id: fieldId },
      include: DEFINITION_INCLUDE,
    });
    if (!row || row.teamId !== teamId) throw Errors.notFound('Custom field not found');
    return toDefinitionView(row);
  }

  async createDefinition(
    teamId: string,
    actorId: string,
    input: CreateCustomFieldBody,
  ): Promise<CustomFieldDefinitionView> {
    if (SELECT_TYPES.has(input.type) && (!input.options || input.options.length === 0)) {
      throw Errors.badRequest('Select fields require at least one option');
    }
    if (!SELECT_TYPES.has(input.type) && input.options && input.options.length > 0) {
      throw Errors.badRequest('Options are only allowed for select field types');
    }
    try {
      const row = await prisma.customFieldDefinition.create({
        data: {
          teamId,
          name: input.name,
          type: input.type,
          description: input.description ?? null,
          position: input.position ?? 0,
          required: input.required ?? false,
          active: input.active ?? true,
          options: input.options
            ? {
                create: input.options.map((o, i) => ({
                  label: o.label,
                  color: o.color ?? null,
                  position: o.position ?? i,
                })),
              }
            : undefined,
        },
        include: DEFINITION_INCLUDE,
      });
      await logActivity(prisma, {
        actorId,
        teamId,
        action: 'customfield.created',
        meta: { fieldId: row.id, name: row.name, type: row.type },
      });
      return toDefinitionView(row);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw Errors.conflict('A custom field with that name already exists in this team');
      }
      throw err;
    }
  }

  async updateDefinition(
    teamId: string,
    fieldId: string,
    actorId: string,
    input: UpdateCustomFieldBody,
  ): Promise<CustomFieldDefinitionView> {
    const existing = await prisma.customFieldDefinition.findUnique({ where: { id: fieldId } });
    if (!existing || existing.teamId !== teamId) throw Errors.notFound('Custom field not found');
    try {
      const row = await prisma.customFieldDefinition.update({
        where: { id: fieldId },
        data: {
          ...(input.name !== undefined && { name: input.name }),
          ...(input.description !== undefined && { description: input.description }),
          ...(input.position !== undefined && { position: input.position }),
          ...(input.required !== undefined && { required: input.required }),
          ...(input.active !== undefined && { active: input.active }),
        },
        include: DEFINITION_INCLUDE,
      });
      await logActivity(prisma, {
        actorId,
        teamId,
        action: 'customfield.updated',
        meta: { fieldId: row.id, name: row.name },
      });
      return toDefinitionView(row);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw Errors.conflict('A custom field with that name already exists in this team');
      }
      throw err;
    }
  }

  async deleteDefinition(teamId: string, fieldId: string, actorId: string): Promise<void> {
    const existing = await prisma.customFieldDefinition.findUnique({ where: { id: fieldId } });
    if (!existing || existing.teamId !== teamId) throw Errors.notFound('Custom field not found');
    await prisma.customFieldDefinition.delete({ where: { id: fieldId } });
    await logActivity(prisma, {
      actorId,
      teamId,
      action: 'customfield.deleted',
      meta: { fieldId, name: existing.name },
    });
  }

  async setOptions(
    teamId: string,
    fieldId: string,
    actorId: string,
    input: SetCustomFieldOptionsBody,
  ): Promise<CustomFieldDefinitionView> {
    const existing = await prisma.customFieldDefinition.findUnique({ where: { id: fieldId } });
    if (!existing || existing.teamId !== teamId) throw Errors.notFound('Custom field not found');
    if (!SELECT_TYPES.has(existing.type)) {
      throw Errors.badRequest('Options can only be set on select field types');
    }

    const row = await prisma.$transaction(async (tx) => {
      await tx.customFieldOption.deleteMany({ where: { fieldId } });
      if (input.options.length > 0) {
        await tx.customFieldOption.createMany({
          data: input.options.map((o, i) => ({
            fieldId,
            label: o.label,
            color: o.color ?? null,
            position: o.position ?? i,
          })),
        });
      }
      return tx.customFieldDefinition.findUniqueOrThrow({
        where: { id: fieldId },
        include: DEFINITION_INCLUDE,
      });
    });

    await logActivity(prisma, {
      actorId,
      teamId,
      action: 'customfield.options_set',
      meta: { fieldId, name: row.name, optionCount: input.options.length },
    });
    return toDefinitionView(row);
  }

  async buildTaskCustomFieldsView(teamId: string, taskId: string): Promise<TaskCustomFieldValueView[]> {
    const [definitions, values] = await Promise.all([
      prisma.customFieldDefinition.findMany({
        where: { teamId },
        include: { options: { orderBy: { position: 'asc' } } },
        orderBy: [{ position: 'asc' }, { name: 'asc' }],
      }),
      prisma.customFieldValue.findMany({
        where: { taskId },
        include: {
          valueUser: { select: { name: true } },
          selections: { include: { option: true } },
        },
      }),
    ]);

    const valueByField = new Map(values.map((v) => [v.fieldId, v]));

    return definitions
      .filter((def) => def.active || valueByField.has(def.id))
      .map((def) => {
        const val = valueByField.get(def.id);
        const optionIds = val?.selections.map((s) => s.optionId) ?? [];
        const optionLabels = val?.selections.map((s) => s.option.label) ?? [];
        return {
          fieldId: def.id,
          fieldName: def.name,
          fieldType: def.type,
          required: def.required,
          active: def.active,
          valueText: val?.valueText ?? null,
          valueNumber:
            val?.valueNumber === null || val?.valueNumber === undefined
              ? null
              : val.valueNumber.toString(),
          valueDate: val?.valueDate ? val.valueDate.toISOString() : null,
          valueBool: val?.valueBool ?? null,
          valueUserId: val?.valueUserId ?? null,
          valueUserName: val?.valueUser?.name ?? null,
          optionIds,
          optionLabels,
        };
      });
  }

  async setTaskValue(
    teamId: string,
    projectId: string,
    taskId: string,
    fieldId: string,
    actorId: string,
    input: SetTaskCustomFieldValueBody,
  ): Promise<TaskCustomFieldValueView[]> {
    const task = await prisma.task.findFirst({
      where: { id: taskId, projectId, teamId, deletedAt: null },
      select: { id: true, teamId: true },
    });
    if (!task) throw Errors.notFound('Task not found');

    const field = await prisma.customFieldDefinition.findUnique({
      where: { id: fieldId },
      include: { options: true },
    });
    if (!field || field.teamId !== teamId) throw Errors.notFound('Custom field not found');

    const clearing = input.clear === true || isEmptyValue(field.type, input);

    if (!field.active && !clearing) {
      throw Errors.badRequest('Cannot set a value on an inactive custom field');
    }

    if (field.required && clearing) {
      throw Errors.badRequest(`"${field.name}" is required and cannot be cleared`);
    }

    if (clearing) {
      await prisma.customFieldValue.deleteMany({ where: { fieldId, taskId } });
      await logActivity(prisma, {
        actorId,
        teamId,
        taskId,
        action: 'task.customfield_set',
        meta: { fieldName: field.name, summary: '(cleared)', cleared: true },
      });
      return this.buildTaskCustomFieldsView(teamId, taskId);
    }

    const data = await this.validateAndBuildValueData(field, teamId, input);

    await prisma.$transaction(async (tx) => {
      const valueRow = await tx.customFieldValue.upsert({
        where: { fieldId_taskId: { fieldId, taskId } },
        create: { fieldId, taskId, ...data.prismaData },
        update: { ...data.prismaData },
      });
      if (SELECT_TYPES.has(field.type)) {
        await tx.customFieldValueOption.deleteMany({ where: { valueId: valueRow.id } });
        if (data.optionIds.length > 0) {
          await tx.customFieldValueOption.createMany({
            data: data.optionIds.map((optionId) => ({ valueId: valueRow.id, optionId })),
          });
        }
      }
    });

    const summary = summariseValue(field.type, {
      valueText: data.prismaData.valueText ?? null,
      valueNumber: data.prismaData.valueNumber ?? null,
      valueDate: data.prismaData.valueDate ?? null,
      valueBool: data.prismaData.valueBool ?? null,
      valueUserName: data.userName,
      optionLabels: data.optionLabels,
    });

    await logActivity(prisma, {
      actorId,
      teamId,
      taskId,
      action: 'task.customfield_set',
      meta: { fieldName: field.name, summary },
    });

    return this.buildTaskCustomFieldsView(teamId, taskId);
  }

  async buildCustomFieldsForTasks(
    teamId: string,
    taskIds: string[],
  ): Promise<Map<string, TaskCustomFieldValueView[]>> {
    const result = new Map<string, TaskCustomFieldValueView[]>();
    for (const id of taskIds) result.set(id, []);
    if (taskIds.length === 0) return result;

    const [definitions, values] = await Promise.all([
      prisma.customFieldDefinition.findMany({
        where: { teamId },
        include: { options: { orderBy: { position: 'asc' } } },
        orderBy: [{ position: 'asc' }, { name: 'asc' }],
      }),
      prisma.customFieldValue.findMany({
        where: { taskId: { in: taskIds } },
        include: {
          valueUser: { select: { name: true } },
          selections: { include: { option: true } },
        },
      }),
    ]);

    const valuesByTask = new Map<string, typeof values>();
    for (const v of values) {
      const list = valuesByTask.get(v.taskId) ?? [];
      list.push(v);
      valuesByTask.set(v.taskId, list);
    }

    for (const taskId of taskIds) {
      const taskValues = valuesByTask.get(taskId) ?? [];
      const valueByField = new Map(taskValues.map((v) => [v.fieldId, v]));
      result.set(
        taskId,
        definitions
          .filter((def) => def.active || valueByField.has(def.id))
          .map((def) => {
            const val = valueByField.get(def.id);
            const optionIds = val?.selections.map((s) => s.optionId) ?? [];
            const optionLabels = val?.selections.map((s) => s.option.label) ?? [];
            return {
              fieldId: def.id,
              fieldName: def.name,
              fieldType: def.type,
              required: def.required,
              active: def.active,
              valueText: val?.valueText ?? null,
              valueNumber:
                val?.valueNumber === null || val?.valueNumber === undefined
                  ? null
                  : val.valueNumber.toString(),
              valueDate: val?.valueDate ? val.valueDate.toISOString() : null,
              valueBool: val?.valueBool ?? null,
              valueUserId: val?.valueUserId ?? null,
              valueUserName: val?.valueUser?.name ?? null,
              optionIds,
              optionLabels,
            };
          }),
      );
    }
    return result;
  }

  private async validateAndBuildValueData(
    field: Prisma.CustomFieldDefinitionGetPayload<{ include: { options: true } }>,
    teamId: string,
    input: SetTaskCustomFieldValueBody,
  ): Promise<{
    prismaData: {
      valueText?: string | null;
      valueNumber?: Prisma.Decimal | null;
      valueDate?: Date | null;
      valueBool?: boolean | null;
      valueUserId?: string | null;
    };
    optionIds: string[];
    optionLabels: string[];
    userName: string | null;
  }> {
    const empty = {
      valueText: null,
      valueNumber: null,
      valueDate: null,
      valueBool: null,
      valueUserId: null,
    };

    switch (field.type) {
      case 'TEXT': {
        const text = input.valueText?.trim() ?? '';
        if (!text) throw Errors.badRequest('Text value is required');
        if (text.length > 2000) throw Errors.badRequest('Text value exceeds 2000 characters');
        return { prismaData: { ...empty, valueText: text }, optionIds: [], optionLabels: [], userName: null };
      }
      case 'NUMBER': {
        if (input.valueNumber === null || input.valueNumber === undefined) {
          throw Errors.badRequest('Number value is required');
        }
        const s =
          typeof input.valueNumber === 'number' ? String(input.valueNumber) : input.valueNumber.trim();
        if (!/^-?\d+(\.\d{1,4})?$/.test(s)) {
          throw Errors.badRequest('Number must be a decimal with up to 4 fractional digits');
        }
        return {
          prismaData: { ...empty, valueNumber: normaliseNumber(input.valueNumber) },
          optionIds: [],
          optionLabels: [],
          userName: null,
        };
      }
      case 'DATE': {
        if (!input.valueDate) throw Errors.badRequest('Date value is required');
        const d = new Date(input.valueDate);
        if (Number.isNaN(d.getTime())) throw Errors.badRequest('Invalid date value');
        return { prismaData: { ...empty, valueDate: d }, optionIds: [], optionLabels: [], userName: null };
      }
      case 'CHECKBOX': {
        if (input.valueBool === null || input.valueBool === undefined) {
          throw Errors.badRequest('Checkbox value is required');
        }
        return {
          prismaData: { ...empty, valueBool: input.valueBool },
          optionIds: [],
          optionLabels: [],
          userName: null,
        };
      }
      case 'PERSON': {
        if (!input.valueUserId) throw Errors.badRequest('Person value is required');
        const membership = await prisma.teamMembership.findUnique({
          where: { userId_teamId: { userId: input.valueUserId, teamId } },
          include: { user: { select: { name: true } } },
        });
        if (!membership) throw Errors.badRequest('Person must be a member of this team');
        return {
          prismaData: { ...empty, valueUserId: input.valueUserId },
          optionIds: [],
          optionLabels: [],
          userName: membership.user.name,
        };
      }
      case 'SINGLE_SELECT': {
        const ids = input.optionIds ?? [];
        if (ids.length > 1) throw Errors.badRequest('Single select allows at most one option');
        if (ids.length === 0) throw Errors.badRequest('Select at least one option');
        const option = field.options.find((o) => o.id === ids[0]);
        if (!option) throw Errors.badRequest('Option does not belong to this field');
        return {
          prismaData: empty,
          optionIds: [option.id],
          optionLabels: [option.label],
          userName: null,
        };
      }
      case 'MULTI_SELECT': {
        const ids = input.optionIds ?? [];
        if (ids.length === 0) throw Errors.badRequest('Select at least one option');
        const optionMap = new Map(field.options.map((o) => [o.id, o]));
        for (const id of ids) {
          if (!optionMap.has(id)) throw Errors.badRequest('Option does not belong to this field');
        }
        const labels = ids.map((id) => optionMap.get(id)!.label);
        return { prismaData: empty, optionIds: ids, optionLabels: labels, userName: null };
      }
      default:
        throw Errors.badRequest('Unsupported field type');
    }
  }
}

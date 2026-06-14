import { api } from '@/lib/api';

export type CustomFieldType =
  | 'TEXT'
  | 'NUMBER'
  | 'DATE'
  | 'SINGLE_SELECT'
  | 'MULTI_SELECT'
  | 'CHECKBOX'
  | 'PERSON';

export interface CustomFieldOption {
  id: string;
  label: string;
  color: string | null;
  position: number;
}

export interface CustomFieldDefinition {
  id: string;
  teamId: string;
  name: string;
  type: CustomFieldType;
  description: string | null;
  position: number;
  required: boolean;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  options: CustomFieldOption[];
}

export interface TaskCustomFieldValue {
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

export async function listCustomFields(teamId: string): Promise<CustomFieldDefinition[]> {
  return (await api.get<CustomFieldDefinition[]>(`/teams/${teamId}/custom-fields`)).data;
}

export async function createCustomField(
  teamId: string,
  input: {
    name: string;
    type: CustomFieldType;
    description?: string | null;
    position?: number;
    required?: boolean;
    active?: boolean;
    options?: Array<{ label: string; color?: string | null; position?: number }>;
  },
): Promise<CustomFieldDefinition> {
  return (await api.post<CustomFieldDefinition>(`/teams/${teamId}/custom-fields`, input)).data;
}

export async function updateCustomField(
  teamId: string,
  fieldId: string,
  input: {
    name?: string;
    description?: string | null;
    position?: number;
    required?: boolean;
    active?: boolean;
  },
): Promise<CustomFieldDefinition> {
  return (
    await api.patch<CustomFieldDefinition>(`/teams/${teamId}/custom-fields/${fieldId}`, input)
  ).data;
}

export async function deleteCustomField(teamId: string, fieldId: string): Promise<void> {
  await api.delete(`/teams/${teamId}/custom-fields/${fieldId}`);
}

export async function setCustomFieldOptions(
  teamId: string,
  fieldId: string,
  options: Array<{ label: string; color?: string | null; position?: number }>,
): Promise<CustomFieldDefinition> {
  return (
    await api.put<CustomFieldDefinition>(`/teams/${teamId}/custom-fields/${fieldId}/options`, {
      options,
    })
  ).data;
}

export async function setTaskCustomFieldValue(
  teamId: string,
  projectId: string,
  taskId: string,
  fieldId: string,
  body: {
    clear?: boolean;
    valueText?: string | null;
    valueNumber?: number | string | null;
    valueDate?: string | null;
    valueBool?: boolean | null;
    valueUserId?: string | null;
    optionIds?: string[];
  },
): Promise<TaskCustomFieldValue[]> {
  return (
    await api.put<TaskCustomFieldValue[]>(
      `/teams/${teamId}/projects/${projectId}/tasks/${taskId}/custom-fields/${fieldId}`,
      body,
    )
  ).data;
}

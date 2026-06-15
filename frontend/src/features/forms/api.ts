import { api } from '@/lib/api';

export type IntakeFormMode = 'TEAM' | 'PUBLIC';

export type IntakeFormFieldTarget =
  | 'title'
  | 'description'
  | 'priority'
  | 'dueDate'
  | 'assignee'
  | 'labels'
  | 'customField';

export interface IntakeFormFieldOption {
  id: string;
  label: string;
  color?: string | null;
}

export interface IntakeFormField {
  id: string;
  label: string;
  target: IntakeFormFieldTarget;
  customFieldId: string | null;
  customFieldType?: string | null;
  required: boolean;
  helpText: string | null;
  position: number;
  options?: IntakeFormFieldOption[];
}

export interface IntakeForm {
  id: string;
  teamId: string;
  projectId: string;
  name: string;
  description: string | null;
  mode: IntakeFormMode;
  publicToken: string | null;
  enabled: boolean;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
  fields: IntakeFormField[];
  publicUrl?: string | null;
}

export interface IntakeFormListItem {
  id: string;
  teamId: string;
  projectId: string;
  name: string;
  description: string | null;
  mode: IntakeFormMode;
  enabled: boolean;
  fieldCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface IntakeFormFieldInput {
  label: string;
  target: IntakeFormFieldTarget;
  customFieldId?: string | null;
  required?: boolean;
  helpText?: string | null;
  position: number;
}

export interface PublicIntakeForm {
  name: string;
  description: string | null;
  fields: IntakeFormField[];
}

export async function listForms(teamId: string): Promise<IntakeFormListItem[]> {
  return (await api.get<{ items: IntakeFormListItem[] }>(`/teams/${teamId}/forms`)).data.items;
}

export async function getForm(teamId: string, formId: string): Promise<IntakeForm> {
  return (await api.get<IntakeForm>(`/teams/${teamId}/forms/${formId}`)).data;
}

export async function createForm(
  teamId: string,
  body: {
    projectId: string;
    name: string;
    description?: string | null;
    mode?: IntakeFormMode;
    enabled?: boolean;
    fields: IntakeFormFieldInput[];
  },
): Promise<IntakeForm> {
  return (await api.post<IntakeForm>(`/teams/${teamId}/forms`, body)).data;
}

export async function updateForm(
  teamId: string,
  formId: string,
  body: Partial<{
    projectId: string;
    name: string;
    description: string | null;
    mode: IntakeFormMode;
    enabled: boolean;
    fields: IntakeFormFieldInput[];
  }>,
): Promise<IntakeForm> {
  return (await api.patch<IntakeForm>(`/teams/${teamId}/forms/${formId}`, body)).data;
}

export async function deleteForm(teamId: string, formId: string): Promise<void> {
  await api.delete(`/teams/${teamId}/forms/${formId}`);
}

export async function rotateFormToken(teamId: string, formId: string): Promise<IntakeForm> {
  return (await api.post<IntakeForm>(`/teams/${teamId}/forms/${formId}/rotate-token`)).data;
}

export async function submitForm(
  teamId: string,
  formId: string,
  values: Record<string, unknown>,
): Promise<{ taskId: string }> {
  return (
    await api.post<{ success: true; taskId: string }>(`/teams/${teamId}/forms/${formId}/submit`, {
      values,
    })
  ).data;
}

export async function fetchPublicForm(token: string): Promise<PublicIntakeForm> {
  return (await api.get<PublicIntakeForm>(`/public/forms/${token}`)).data;
}

export async function submitPublicForm(
  token: string,
  values: Record<string, unknown>,
  website?: string,
): Promise<void> {
  await api.post(`/public/forms/${token}/submit`, { values, website });
}

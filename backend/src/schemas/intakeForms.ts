import { z } from 'zod';
import { customFieldTypeEnum } from './customFields.js';

export const intakeFormModeEnum = z.enum(['TEAM', 'PUBLIC']);

export const intakeFormFieldTargetEnum = z.enum([
  'title',
  'description',
  'priority',
  'dueDate',
  'assignee',
  'labels',
  'customField',
]);

export const intakeFormFieldInput = z.object({
  label: z.string().min(1).max(200).trim(),
  target: intakeFormFieldTargetEnum,
  customFieldId: z.string().nullable().optional(),
  required: z.boolean().optional(),
  helpText: z.string().max(500).trim().nullable().optional(),
  position: z.number().int().nonnegative(),
});

export const createIntakeFormBody = z.object({
  projectId: z.string(),
  name: z.string().min(1).max(200).trim(),
  description: z.string().max(2000).trim().nullable().optional(),
  mode: intakeFormModeEnum.optional(),
  enabled: z.boolean().optional(),
  fields: z.array(intakeFormFieldInput).min(1),
});

export const updateIntakeFormBody = z
  .object({
    projectId: z.string().optional(),
    name: z.string().min(1).max(200).trim().optional(),
    description: z.string().max(2000).trim().nullable().optional(),
    mode: intakeFormModeEnum.optional(),
    enabled: z.boolean().optional(),
    fields: z.array(intakeFormFieldInput).min(1).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Provide at least one field to update');

export const intakeFormFieldRenderOption = z.object({
  id: z.string(),
  label: z.string(),
  color: z.string().nullable().optional(),
});

export const intakeFormFieldRender = z.object({
  id: z.string(),
  label: z.string(),
  target: intakeFormFieldTargetEnum,
  customFieldId: z.string().nullable(),
  customFieldType: customFieldTypeEnum.nullable().optional(),
  required: z.boolean(),
  helpText: z.string().nullable(),
  position: z.number().int(),
  options: z.array(intakeFormFieldRenderOption).optional(),
});

export const intakeFormResponse = z.object({
  id: z.string(),
  teamId: z.string(),
  projectId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  mode: intakeFormModeEnum,
  publicToken: z.string().nullable(),
  enabled: z.boolean(),
  createdById: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  fields: z.array(intakeFormFieldRender),
  publicUrl: z.string().nullable().optional(),
});

export const intakeFormsListResponse = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      teamId: z.string(),
      projectId: z.string(),
      name: z.string(),
      description: z.string().nullable(),
      mode: intakeFormModeEnum,
      enabled: z.boolean(),
      fieldCount: z.number().int(),
      createdAt: z.string(),
      updatedAt: z.string(),
    }),
  ),
});

export const publicIntakeFormRenderResponse = z.object({
  name: z.string(),
  description: z.string().nullable(),
  fields: z.array(intakeFormFieldRender),
});

export const intakeFormSubmitBody = z.object({
  values: z.record(z.string(), z.unknown()),
  // Honeypot — must stay empty; bots that fill it get a silent fake success.
  website: z.string().max(500).optional(),
});

export const intakeFormSubmitResponse = z.object({
  success: z.literal(true),
});

export const intakeFormSubmitTeamResponse = z.object({
  success: z.literal(true),
  taskId: z.string(),
});

export type CreateIntakeFormBody = z.infer<typeof createIntakeFormBody>;
export type UpdateIntakeFormBody = z.infer<typeof updateIntakeFormBody>;
export type IntakeFormFieldInput = z.infer<typeof intakeFormFieldInput>;
export type IntakeFormSubmitBody = z.infer<typeof intakeFormSubmitBody>;

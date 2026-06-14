import { z } from 'zod';

export const customFieldTypeEnum = z.enum([
  'TEXT',
  'NUMBER',
  'DATE',
  'SINGLE_SELECT',
  'MULTI_SELECT',
  'CHECKBOX',
  'PERSON',
]);

export const customFieldOptionInput = z.object({
  label: z.string().min(1).max(100).trim(),
  color: z.string().max(20).nullable().optional(),
  position: z.number().int().nonnegative().optional(),
});

export const createCustomFieldBody = z.object({
  name: z.string().min(1).max(100).trim(),
  type: customFieldTypeEnum,
  description: z.string().max(500).trim().nullable().optional(),
  position: z.number().int().nonnegative().optional(),
  required: z.boolean().optional(),
  active: z.boolean().optional(),
  options: z.array(customFieldOptionInput).optional(),
});

export const updateCustomFieldBody = z
  .object({
    name: z.string().min(1).max(100).trim().optional(),
    description: z.string().max(500).trim().nullable().optional(),
    position: z.number().int().nonnegative().optional(),
    required: z.boolean().optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Provide at least one field to update');

export const setCustomFieldOptionsBody = z.object({
  options: z.array(customFieldOptionInput),
});

const numberValueSchema = z
  .union([z.number(), z.string()])
  .nullable()
  .optional()
  .superRefine((v, ctx) => {
    if (v === null || v === undefined) return;
    const s = typeof v === 'number' ? String(v) : v.trim();
    if (s.length === 0) return;
    if (!/^-?\d+(\.\d{1,4})?$/.test(s)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'must be a decimal with up to 4 fractional digits',
      });
    }
  });

export const setTaskCustomFieldValueBody = z.object({
  clear: z.boolean().optional(),
  valueText: z.string().max(2000).nullable().optional(),
  valueNumber: numberValueSchema,
  valueDate: z.string().datetime().nullable().optional(),
  valueBool: z.boolean().nullable().optional(),
  valueUserId: z.string().nullable().optional(),
  optionIds: z.array(z.string()).optional(),
});

export const customFieldOptionResponse = z.object({
  id: z.string(),
  label: z.string(),
  color: z.string().nullable(),
  position: z.number().int(),
});

export const customFieldDefinitionResponse = z.object({
  id: z.string(),
  teamId: z.string(),
  name: z.string(),
  type: customFieldTypeEnum,
  description: z.string().nullable(),
  position: z.number().int(),
  required: z.boolean(),
  active: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  options: z.array(customFieldOptionResponse),
});

export const taskCustomFieldValueResponse = z.object({
  fieldId: z.string(),
  fieldName: z.string(),
  fieldType: customFieldTypeEnum,
  required: z.boolean(),
  active: z.boolean(),
  valueText: z.string().nullable(),
  valueNumber: z.string().nullable(),
  valueDate: z.string().nullable(),
  valueBool: z.boolean().nullable(),
  valueUserId: z.string().nullable(),
  valueUserName: z.string().nullable(),
  optionIds: z.array(z.string()),
  optionLabels: z.array(z.string()),
});

export type CreateCustomFieldBody = z.infer<typeof createCustomFieldBody>;
export type UpdateCustomFieldBody = z.infer<typeof updateCustomFieldBody>;
export type SetCustomFieldOptionsBody = z.infer<typeof setCustomFieldOptionsBody>;
export type SetTaskCustomFieldValueBody = z.infer<typeof setTaskCustomFieldValueBody>;

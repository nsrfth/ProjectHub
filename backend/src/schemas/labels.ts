import { z } from 'zod';

// `#RRGGBB` only. We could allow shorthand `#RGB` but normalizing in the UI
// layer keeps the server contract narrow and stops mixed-case duplicates.
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Color must be a #RRGGBB hex string');

export const createLabelBody = z.object({
  name: z.string().min(1).max(40).trim(),
  color: hexColor,
});

export const updateLabelBody = z
  .object({
    name: z.string().min(1).max(40).trim().optional(),
    color: hexColor.optional(),
  })
  .refine((v) => v.name !== undefined || v.color !== undefined, 'Provide at least one field');

export const labelResponse = z.object({
  id: z.string(),
  // v1.80: null for a global "predefined" label (admin-managed, all teams).
  teamId: z.string().nullable(),
  name: z.string(),
  color: z.string(),
  isPredefined: z.boolean(),
});

export type CreateLabelBody = z.infer<typeof createLabelBody>;
export type UpdateLabelBody = z.infer<typeof updateLabelBody>;

import { z } from 'zod';

// v1.23: roles + permissions API shapes. Permission strings are validated
// against the constants in lib/permissions.ts at the service layer; the
// Zod schema only enforces "non-empty string" so we don't have to keep two
// lists in sync.

export const roleNameSchema = z.string().min(1).max(60).trim();
export const roleDescriptionSchema = z.string().max(500).trim().nullable().optional();

export const createRoleBody = z.object({
  name: roleNameSchema,
  description: roleDescriptionSchema,
  // Initial permission set. The service rejects unknown strings.
  permissions: z.array(z.string().min(1)).default([]),
});

export const updateRoleBody = z
  .object({
    name: roleNameSchema.optional(),
    description: roleDescriptionSchema,
  })
  .refine(
    (v) => v.name !== undefined || v.description !== undefined,
    'Provide at least one field to update',
  );

export const setPermissionsBody = z.object({
  // Full replacement set — idempotent. PATCH-style "add/remove" would need
  // two endpoints; one PUT is simpler.
  permissions: z.array(z.string().min(1)),
});

export const roleResponse = z.object({
  id: z.string(),
  teamId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  isSystem: z.boolean(),
  permissions: z.array(z.string()),
  // Surfaced so the UI can show "5 members have this role" + disable Delete.
  membershipCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const rolesListResponse = z.object({
  items: z.array(roleResponse),
});

export type CreateRoleBody = z.infer<typeof createRoleBody>;
export type UpdateRoleBody = z.infer<typeof updateRoleBody>;
export type SetPermissionsBody = z.infer<typeof setPermissionsBody>;

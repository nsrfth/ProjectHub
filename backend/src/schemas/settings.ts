import { z } from 'zod';

// Instance-level settings: a key-value store of admin-managed toggles + config.
// Shape of `value` is intentionally loose at the schema layer (JSONB) — the
// per-key shape is enforced wherever the setting is consumed (e.g. SMTP code
// validates the SMTP block when reading). For Phase 1 we only ship CRUD over
// the bare key/value pairs.
export const instanceSettingResponse = z.object({
  key: z.string().min(1).max(120),
  value: z.unknown(),
  updatedAt: z.string(),
  updatedBy: z.string().nullable(),
});

export const instanceSettingsListResponse = z.object({
  items: z.array(instanceSettingResponse),
});

export const instanceSettingKeyParams = z.object({
  // Dot-delimited namespaces are encouraged ("registration.public",
  // "smtp.host") — the API doesn't enforce a grammar, but the convention
  // keeps the future settings UI organisable.
  key: z.string().min(1).max(120),
});

export const instanceSettingUpsertBody = z.object({
  // `value` is required and may be any JSON-serialisable value. `null` is
  // explicitly allowed so a client can store "feature disabled" without
  // having to delete the key.
  value: z.unknown(),
});

export type InstanceSettingResponse = z.infer<typeof instanceSettingResponse>;
export type InstanceSettingsListResponse = z.infer<typeof instanceSettingsListResponse>;
export type InstanceSettingKeyParams = z.infer<typeof instanceSettingKeyParams>;
export type InstanceSettingUpsertBody = z.infer<typeof instanceSettingUpsertBody>;

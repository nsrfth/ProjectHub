import { z } from 'zod';
import { SCOPES } from '../lib/scopes.js';

// Per-user API token CRUD. v1.30.3 (S-2): scopes are now ENFORCED at the
// route layer via requireScope(). The create body restricts inputs to the
// known vocabulary in lib/scopes.ts so admins can't accidentally mint a
// token whose advisory-looking scope string (typo'd or invented) silently
// matches no gates. Existing rows with arbitrary scope strings keep
// loading — only future creates are validated.

export const apiTokenCreateBody = z.object({
  name: z.string().min(1).max(120),
  scopes: z
    .array(z.enum(SCOPES))
    .min(1, 'Pick at least one scope (use "*" for full access)')
    .default(['*']),
  expiresAt: z.string().datetime().nullable().optional(),
});

export const apiTokenRedactedResponse = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(z.string()),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});

export const apiTokenCreatedResponse = apiTokenRedactedResponse.extend({
  // One-shot raw token. The frontend hands it to the admin in a modal and
  // forgets it; subsequent reads never include this field.
  rawToken: z.string(),
});

export const apiTokenListResponse = z.object({
  items: z.array(apiTokenRedactedResponse),
});

export const apiTokenIdParams = z.object({ tokenId: z.string() });

export type ApiTokenCreateBody = z.infer<typeof apiTokenCreateBody>;

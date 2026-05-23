import { z } from 'zod';

// Per-user API token CRUD. Scopes are free-form strings — convention is
// `<resource>:<action>` (e.g. "tasks:read") or "*" for full access; Phase
// 3B doesn't enforce them at the route layer (the auth middleware just
// attaches the token's owner) so they're advisory until a future phase
// gates routes on them.

export const apiTokenCreateBody = z.object({
  name: z.string().min(1).max(120),
  scopes: z.array(z.string().min(1).max(60)).default(['*']),
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

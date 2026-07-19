import { z } from 'zod';

export const directoryKindEnum = z.enum(['LDAP', 'SCIM']);

// Body for creating or updating a Directory. bindPassword is plaintext on the
// wire (TLS protects it in transit) and gets encrypted server-side before
// landing in the DB. Optional on update so an admin can change name/host
// without re-typing the password.
export const directoryCreateBody = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().min(3).max(60).regex(/^[a-z0-9-]+$/, 'lowercase, digits, hyphens'),
  kind: directoryKindEnum.default('LDAP'),
  host: z.string().min(1).max(255).optional(),
  port: z.number().int().positive().max(65535).optional(),
  useTLS: z.boolean().default(true),
  tlsInsecure: z.boolean().default(false),
  bindDN: z.string().min(1).max(500).optional(),
  bindPassword: z.string().min(1).max(500).optional(),
  baseDN: z.string().min(1).max(500).optional(),
  userFilter: z.string().max(500).optional(),
  groupFilter: z.string().max(500).optional(),
  userIdAttr: z.string().min(1).max(60).default('uid'),
  emailAttr: z.string().min(1).max(60).default('mail'),
  nameAttr: z.string().min(1).max(60).default('cn'),
  groupMemberAttr: z.string().min(1).max(60).default('member'),
  allowJIT: z.boolean().default(true),
  syncRolesFromGroups: z.boolean().default(false),
  // v2.6 (Phase 0a): scheduled sync opt-in, separate from the login-time
  // syncRolesFromGroups above. See docs/DIRECTORY_SYNC.md §9.
  syncEnabled: z.boolean().default(false),
  syncTrustMemberOf: z.boolean().default(false),
});

export const directoryUpdateBody = directoryCreateBody.partial();

// Response shape — bindPasswordEnc DELIBERATELY excluded. fastify-type-provider-zod
// strips unknown fields at serialisation, so even if a service-layer mistake
// leaks the ciphertext upward, this shape blocks it from reaching the wire.
export const directoryResponse = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  kind: directoryKindEnum,
  host: z.string().nullable(),
  port: z.number().int().nullable(),
  useTLS: z.boolean(),
  tlsInsecure: z.boolean(),
  bindDN: z.string().nullable(),
  // A boolean projection of bindPasswordEnc — surfaces whether the password
  // is set without exposing the value. Lets the UI distinguish "no password"
  // from "password set but not editable here".
  hasBindPassword: z.boolean(),
  baseDN: z.string().nullable(),
  userFilter: z.string().nullable(),
  groupFilter: z.string().nullable(),
  userIdAttr: z.string(),
  emailAttr: z.string(),
  nameAttr: z.string(),
  groupMemberAttr: z.string(),
  allowJIT: z.boolean(),
  syncRolesFromGroups: z.boolean(),
  syncEnabled: z.boolean(),
  syncTrustMemberOf: z.boolean(),
  lastSyncAt: z.string().nullable(),
  lastSyncStatus: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const directoryListResponse = z.object({
  items: z.array(directoryResponse),
});

export const directoryIdParams = z.object({ directoryId: z.string() });

// --- v2.6 (Phase 0a): scheduled directory sync ------------------------

export const directorySyncBody = z.object({
  // Observation mode: full scan + conflict detection, zero writes. Defaults
  // TRUE so an admin who clicks without thinking rehearses rather than acts.
  dryRun: z.boolean().default(true),
});

export const directorySyncConflictSchema = z.object({
  code: z.enum([
    'GLOBAL_ROLE_CONFLICT',
    'TEAM_ROLE_CONFLICT',
    'MAPPING_TARGET_MISSING',
    'MAPPING_DN_COLLISION',
    'MAPPING_DN_ESCAPED',
    'IDENTITY_COLLISION',
    'USER_MISSING_EMAIL',
    'LAST_ADMIN_PROTECTED',
  ]),
  message: z.string(),
  userId: z.string().optional(),
  externalId: z.string().optional(),
  teamId: z.string().optional(),
  mappingIds: z.array(z.string()).optional(),
});

export const directorySyncDirectoryResultSchema = z.object({
  directoryId: z.string(),
  directorySlug: z.string(),
  status: z.enum(['OK', 'ABORTED', 'SKIPPED']),
  abortReason: z.string().optional(),
  usersEnumerated: z.number().int(),
  usersMatched: z.number().int(),
  usersUnmatched: z.number().int(),
  usersProvisioned: z.number().int(),
  usersSkippedNoJit: z.number().int(),
  membershipsAdded: z.number().int(),
  membershipsUpdated: z.number().int(),
  membershipsRemoved: z.number().int(),
  globalRolesChanged: z.number().int(),
  conflicts: z.array(directorySyncConflictSchema),
});

export const directorySyncResponse = z.object({
  runId: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  dryRun: z.boolean(),
  directories: z.array(directorySyncDirectoryResultSchema),
});

// DirectoryGroupMapping schemas — group DN → role.
//
// v1.30.6 (S-6 / S-7) adds optional `roleId` — the admin can point a
// mapping at a custom Role row directly. When omitted, the service
// derives the team's system Manager/Member role from `teamRole`.
export const groupMappingCreateBody = z.object({
  externalGroupDn: z.string().min(1).max(500),
  globalRole: z.enum(['ADMIN', 'MEMBER']).nullable().default(null),
  teamId: z.string().nullable().default(null),
  teamRole: z.enum(['MANAGER', 'MEMBER']).nullable().default(null),
  roleId: z.string().nullable().default(null),
});

export const groupMappingResponse = z.object({
  id: z.string(),
  directoryId: z.string(),
  externalGroupDn: z.string(),
  globalRole: z.enum(['ADMIN', 'MEMBER']).nullable(),
  teamId: z.string().nullable(),
  teamRole: z.enum(['MANAGER', 'MEMBER']).nullable(),
  roleId: z.string().nullable(),
});

export const groupMappingListResponse = z.object({
  items: z.array(groupMappingResponse),
});

export const groupMappingIdParams = z.object({
  directoryId: z.string(),
  mappingId: z.string(),
});

// Test-connection body — admins can validate config before saving.
export const directoryTestBody = z.object({
  // Allow overriding password during test so admin can verify a change
  // without persisting it.
  bindPassword: z.string().optional(),
});

export const directoryTestResponse = z.object({
  ok: z.boolean(),
  message: z.string(),
  sampleUserCount: z.number().int().optional(),
});

// SCIM credential surface — the ciphertext token is never exposed; only the
// `rawToken` field on the create-response surfaces the plaintext, exactly
// once. The redacted shape (no rawToken) is used by GET.
export const scimCredentialGenerateBody = z.object({
  name: z.string().min(1).max(120),
});

export const scimCredentialRedactedResponse = z.object({
  id: z.string(),
  directoryId: z.string(),
  name: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});

// Used only by POST /scim — includes the one-shot raw token.
export const scimCredentialCreatedResponse = scimCredentialRedactedResponse.extend({
  rawToken: z.string(),
});

export type DirectoryCreateBody = z.infer<typeof directoryCreateBody>;
export type DirectoryUpdateBody = z.infer<typeof directoryUpdateBody>;
export type GroupMappingCreateBody = z.infer<typeof groupMappingCreateBody>;
export type DirectoryTestBody = z.infer<typeof directoryTestBody>;
export type ScimCredentialGenerateBody = z.infer<typeof scimCredentialGenerateBody>;

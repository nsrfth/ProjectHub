// SCIM 2.0 (RFC 7643/7644) serialization helpers + a deliberately-minimal
// filter parser. Phase 2B supports the subset of SCIM that off-the-shelf
// IdPs (Okta, Azure AD) actually exercise during provisioning: list with
// a single `attr eq "value"` filter, full PUT replace, PATCH for `active`
// + `members`, and DELETE. Anything outside that returns 501.

export const SCIM_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const SCIM_GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
export const SCIM_LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';
export const SCIM_PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

export interface ScimEmail { value: string; primary?: boolean; type?: string }
export interface ScimName { givenName?: string; familyName?: string; formatted?: string }
export interface ScimMemberRef { value: string; display?: string; type?: 'User' | 'Group' }

// Resource the server returns. `meta` is required by spec; resourceType
// distinguishes Users from Groups.
export interface ScimUserResource {
  schemas: [typeof SCIM_USER_SCHEMA];
  id: string;
  externalId?: string;
  userName: string;
  name?: ScimName;
  displayName?: string;
  emails?: ScimEmail[];
  active: boolean;
  meta: { resourceType: 'User'; created: string; lastModified: string; location: string };
}

export interface ScimGroupResource {
  schemas: [typeof SCIM_GROUP_SCHEMA];
  id: string;
  externalId?: string;
  displayName: string;
  members?: ScimMemberRef[];
  meta: { resourceType: 'Group'; created: string; lastModified: string; location: string };
}

export interface ScimListResponse<T> {
  schemas: [typeof SCIM_LIST_SCHEMA];
  totalResults: number;
  startIndex: number;
  itemsPerPage: number;
  Resources: T[];
}

export interface ScimErrorResponse {
  schemas: [typeof SCIM_ERROR_SCHEMA];
  status: string; // SCIM spec: numeric string.
  detail: string;
  scimType?: string;
}

export function scimError(status: number, detail: string, scimType?: string): ScimErrorResponse {
  return {
    schemas: [SCIM_ERROR_SCHEMA],
    status: String(status),
    detail,
    ...(scimType ? { scimType } : {}),
  };
}

// ── Filter parser ─────────────────────────────────────────────────────────
// Spec covers a SQL-ish grammar (and/or/not, contains/starts-with, brackets).
// We only need exact-match lookups during IdP sync, so we parse the single
// most common form:
//
//   <attr> eq "<value>"
//
// Anything else (compound expressions, non-`eq` operators) returns
// `{ ok: false }` — the caller responds with 400 + scimType "invalidFilter".
export interface ScimEqFilter {
  ok: true;
  attribute: string;
  value: string;
}
export interface ScimFilterUnsupported {
  ok: false;
  detail: string;
}
export function parseScimFilter(raw: string | undefined): ScimEqFilter | ScimFilterUnsupported | null {
  if (!raw || !raw.trim()) return null;
  const trimmed = raw.trim();
  // Reject obvious compound expressions early so the caller can return 400.
  if (/\s+(and|or|not)\s+/i.test(trimmed) || /[()]/.test(trimmed)) {
    return { ok: false, detail: 'Only `attr eq "value"` filters are supported' };
  }
  // attr eq "value" — attribute is alphanumeric + dots (for sub-attrs like emails.value).
  const m = /^([A-Za-z][\w.]*)\s+eq\s+"((?:[^"\\]|\\.)*)"$/.exec(trimmed);
  if (!m) return { ok: false, detail: 'Only `attr eq "value"` filters are supported' };
  return { ok: true, attribute: m[1]!, value: m[2]!.replace(/\\"/g, '"').replace(/\\\\/g, '\\') };
}

// Pagination defaults per RFC 7644 §3.4.2.4.
export function parsePagination(q: { startIndex?: unknown; count?: unknown }): { startIndex: number; count: number } {
  const startIndex = Math.max(1, Number(q.startIndex ?? 1) || 1);
  const count = Math.max(0, Math.min(200, Number(q.count ?? 100) || 100));
  return { startIndex, count };
}

// ── PATCH op parser ───────────────────────────────────────────────────────
// SCIM PATCH (RFC 7644 §3.5.2) carries an Operations[] array. Each op has
// op (add|remove|replace), an optional path, and a value. We narrow this
// to the cases IdPs actually send: replace on `active`, replace on top-level
// scalars, and replace/add/remove on `members`.
export interface ScimPatchOp {
  op: 'add' | 'remove' | 'replace';
  path?: string;
  value?: unknown;
}
export function parsePatchOps(body: unknown): ScimPatchOp[] | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.Operations)) return null;
  const ops: ScimPatchOp[] = [];
  for (const raw of b.Operations) {
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    const op = String(o.op ?? '').toLowerCase();
    if (op !== 'add' && op !== 'remove' && op !== 'replace') return null;
    ops.push({
      op: op as 'add' | 'remove' | 'replace',
      path: typeof o.path === 'string' ? o.path : undefined,
      value: o.value,
    });
  }
  return ops;
}

// ── Resource builders ─────────────────────────────────────────────────────
export function userResource(opts: {
  id: string;
  externalId?: string | null;
  userName: string;
  name?: { givenName?: string | null; familyName?: string | null } | null;
  displayName?: string;
  emails?: { value: string; primary?: boolean }[];
  active: boolean;
  created: Date;
  lastModified: Date;
  baseUrl: string;
}): ScimUserResource {
  const resource: ScimUserResource = {
    schemas: [SCIM_USER_SCHEMA],
    id: opts.id,
    userName: opts.userName,
    active: opts.active,
    meta: {
      resourceType: 'User',
      created: opts.created.toISOString(),
      lastModified: opts.lastModified.toISOString(),
      location: `${opts.baseUrl}/Users/${opts.id}`,
    },
  };
  if (opts.externalId) resource.externalId = opts.externalId;
  if (opts.displayName) resource.displayName = opts.displayName;
  if (opts.name && (opts.name.givenName || opts.name.familyName)) {
    resource.name = {};
    if (opts.name.givenName) resource.name.givenName = opts.name.givenName;
    if (opts.name.familyName) resource.name.familyName = opts.name.familyName;
  }
  if (opts.emails && opts.emails.length) resource.emails = opts.emails;
  return resource;
}

export function groupResource(opts: {
  id: string;
  externalId?: string | null;
  displayName: string;
  members?: { value: string; display?: string }[];
  created: Date;
  lastModified: Date;
  baseUrl: string;
}): ScimGroupResource {
  const resource: ScimGroupResource = {
    schemas: [SCIM_GROUP_SCHEMA],
    id: opts.id,
    displayName: opts.displayName,
    meta: {
      resourceType: 'Group',
      created: opts.created.toISOString(),
      lastModified: opts.lastModified.toISOString(),
      location: `${opts.baseUrl}/Groups/${opts.id}`,
    },
  };
  if (opts.externalId) resource.externalId = opts.externalId;
  if (opts.members && opts.members.length) {
    resource.members = opts.members.map((m) => ({ ...m, type: 'User' as const }));
  }
  return resource;
}

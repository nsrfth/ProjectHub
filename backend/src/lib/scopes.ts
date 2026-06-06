// v1.30.3 (S-2): API-token scope vocabulary + check helper.
//
// Until this release, an API token's `scopes` array was stored, transmitted,
// and attached to the request — but never validated. A `tasks:read` token
// could DELETE any task or mint another API token. The route layer now
// gates every write (and most reads) with `requireScope(...)`; this file
// is the single source of truth for the vocabulary.
//
// NEW SCOPE CHECKLIST (read before adding):
//   1. Add the string to `SCOPES` below.
//   2. Decide which existing routes should require it; gate them via
//      `requireScope('...')` in the route file.
//   3. If the new scope lives between read/write tiers, also wire it
//      into the frontend create-token UI's option list.
//   4. Add a regression test that (a) the scope grants the action,
//      (b) a different scope is rejected, (c) `*` always passes.

export const SCOPES = [
  // Wildcard. Both API tokens explicitly set to '*' AND any JWT session
  // are treated as having all scopes — sessions are the user themselves
  // and don't need a token-level capability layer above the existing
  // requirePermission / requireTeamRole / requireGlobalAdmin gates.
  '*',
  // Tasks family — covers Task CRUD, subtasks, attachments, label
  // attach/detach on a task, and trash restore for tasks. Notifications
  // (which are task-event derived) also fall under this bucket.
  'tasks:read',
  'tasks:write',
  // Comments are split from tasks because moderation (delete others') is
  // a separate concern and tokens automating "post status updates" often
  // shouldn't be allowed to read every thread.
  'comments:read',
  'comments:write',
  // Projects (the container) and team-scoped Label CRUD live here.
  'projects:read',
  'projects:write',
  // Webhooks — separate because the surface is integration-only.
  'webhooks:manage',
  // Admin — anything previously gated by GlobalRole=ADMIN: /api/admin/*,
  // instance settings, role mgmt, team creation/membership, api-token
  // mgmt. Tokens with this scope are essentially full-privilege; document
  // accordingly in the UI.
  'admin',
] as const;

export type Scope = (typeof SCOPES)[number];

const SCOPE_SET: ReadonlySet<string> = new Set(SCOPES);
export function isValidScope(value: string): value is Scope {
  return SCOPE_SET.has(value);
}

// True when the granted set covers the required scope. `*` covers
// everything. Otherwise an exact match is required (read does NOT imply
// write, write does NOT imply read).
export function scopesGrant(grantedScopes: readonly string[], required: Scope): boolean {
  if (grantedScopes.includes('*')) return true;
  return grantedScopes.includes(required);
}

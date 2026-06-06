import type { preHandlerHookHandler } from 'fastify';
import { Errors } from '../lib/errors.js';
import { scopesGrant, type Scope } from '../lib/scopes.js';

// v1.30.3 (S-2): per-route API-token scope gate.
//
// Composition contract:
//   - This runs AFTER `requireAuth`. The auth middleware decided whether
//     the request is JWT-backed (no `apiTokenScopes` on the request) or
//     API-token-backed (`apiTokenScopes: string[]`).
//   - JWT sessions get an implicit `*` — sessions are the user themselves,
//     and our access-control layers (requireTeamRole, requirePermission,
//     requireGlobalAdmin, requireGlobalRole) already gate them.
//   - API-token requests must have either `*` or the exact required scope
//     in their granted set.
//   - 403 (not 401) on a scope miss: the caller IS authenticated, they
//     just lack the right capability.
//
// requireScope STACKS with the existing role/permission gates — it does
// not replace them. A `tasks:write` token still gets rejected on
// `task.delete` if its caller lacks the per-team permission.

export function requireScope(required: Scope): preHandlerHookHandler {
  return async (request) => {
    if (!request.user) throw Errors.unauthorized();
    const tokenScopes = (request as { apiTokenScopes?: string[] }).apiTokenScopes;
    // JWT-session request — no token scopes attached. Implicit `*`.
    if (!tokenScopes) return;
    if (scopesGrant(tokenScopes, required)) return;
    throw Errors.forbidden(`API token missing required scope: ${required}`);
  };
}

// v1.30.3 (S-2): "session-only" gate for endpoints that must not be
// reachable by ANY API token — including `*`-scoped ones. The canonical
// use is /api/settings/api-tokens (mint + revoke): we don't want a leaked
// wildcard token to chain itself into a fresh persistence token. Sessions
// are the user themselves (a browser with valid JWTs) and are required
// for these meta operations.
export const requireSessionAuth: preHandlerHookHandler = async (request) => {
  if (!request.user) throw Errors.unauthorized();
  if ((request as { apiTokenScopes?: string[] }).apiTokenScopes !== undefined) {
    throw Errors.forbidden('This endpoint is not callable with an API token');
  }
};

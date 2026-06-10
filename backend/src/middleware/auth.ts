import type { FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify';
import type { GlobalRole, TeamRole } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';
import { resolveTeamMembership } from '../lib/systemUser.js';
import { ApiTokensService } from '../services/apiTokensService.js';

const _apiTokens = new ApiTokensService();

// Verifies the bearer access token and attaches `request.user`. Accepts two
// shapes: a JWT (issued by /auth/login) or an API token (issued by
// /settings/api-tokens, prefixed `th_`). API-token auth resolves the owning
// user, populates request.user as if they'd logged in, and attaches the
// token's scopes for future scope-aware route guards.
//
// Deny-by-default: any route without `requireAuth` is public, so apply it
// explicitly.
export const requireAuth: preHandlerHookHandler = async (request, _reply) => {
  const header = request.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) throw Errors.unauthorized('Missing bearer token');
  const token = header.slice('Bearer '.length).trim();

  // API-token shape — branch before JWT verification so we don't pay the
  // verify cost for tokens that obviously aren't JWTs.
  if (_apiTokens.isApiTokenShape(token)) {
    const verified = await _apiTokens.verify(token);
    if (!verified) throw Errors.unauthorized('Invalid or expired token');
    const user = await prisma.user.findUnique({ where: { id: verified.ownerId } });
    if (!user || user.disabledAt) throw Errors.unauthorized('Invalid or expired token');
    request.user = {
      sub: user.id,
      email: user.email,
      globalRole: user.globalRole,
    } as never;
    (request as { apiTokenScopes?: string[] }).apiTokenScopes = verified.scopes;
    return;
  }

  // JWT path.
  try {
    request.user = request.server.verifyAccess(token);
  } catch {
    throw Errors.unauthorized('Invalid or expired token');
  }
};

export function requireGlobalRole(...allowed: GlobalRole[]): preHandlerHookHandler {
  return async (request) => {
    if (!request.user) throw Errors.unauthorized();
    if (!allowed.includes(request.user.globalRole)) throw Errors.forbidden('Insufficient role');
  };
}

// Convenience wrapper around requireGlobalRole — the common gate for
// instance-level settings and admin tooling. Prefer the named export at call
// sites so intent reads directly ("admin-only").
export const requireGlobalAdmin: preHandlerHookHandler = requireGlobalRole('ADMIN');

// Convenience wrapper for team-manager-only routes. Equivalent to
// requireTeamRole('MANAGER') but named so the intent ("manager-only,
// team-scoped") is obvious at the call site.
export const requireTeamManager: preHandlerHookHandler = requireTeamRole('MANAGER');

// Gate for self-only or admin-override routes. The route MUST declare a
// `:userId` path param. GlobalRole.ADMIN can act on any user; everyone else
// can only act on themselves. Used for "edit my profile", "delete my account",
// "change my password" — anything user-scoped that admins also need to manage.
export const requireSelf: preHandlerHookHandler = async (request) => {
  if (!request.user) throw Errors.unauthorized();
  const userId = (request.params as { userId?: string } | undefined)?.userId;
  if (!userId) throw Errors.badRequest('Missing userId in route');
  if (request.user.globalRole === 'ADMIN') return;
  if (request.user.sub !== userId) throw Errors.forbidden('Cannot act on another user');
};

// SCIM Bearer-token auth — entirely separate from the user JWT path. The
// `Authorization: Bearer <opaque-token>` header is hashed and looked up
// against ScimCredential.tokenHash. On success the resolved directoryId is
// attached to the request so route handlers know which tenant to scope to.
// On failure we deliberately return a SCIM-shaped 401 (handled centrally).
import { ScimCredentialsService } from '../services/scimCredentialsService.js';
const _scimCreds = new ScimCredentialsService();
export const requireScimAuth: preHandlerHookHandler = async (request) => {
  const header = request.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) throw Errors.unauthorized('Missing bearer token');
  const token = header.slice('Bearer '.length).trim();
  const directoryId = await _scimCreds.verify(token);
  if (!directoryId) throw Errors.unauthorized('Invalid SCIM credential');
  (request as { scimDirectoryId?: string }).scimDirectoryId = directoryId;
};

// Asserts that the authenticated user has at least the given role in the team
// referenced by `:teamId` (path param). Returns the membership row for reuse.
export function requireTeamRole(...allowed: TeamRole[]): preHandlerHookHandler {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    if (!request.user) throw Errors.unauthorized();
    const teamId = (request.params as { teamId?: string } | undefined)?.teamId;
    if (!teamId) throw Errors.badRequest('Missing teamId in route');

    const membership = await resolveTeamMembership(request.user.sub, teamId);
    if (!membership) throw Errors.forbidden('Not a team member');
    if (!allowed.includes(membership.role)) throw Errors.forbidden('Insufficient team role');

    (request as any).membership = membership;
  };
}

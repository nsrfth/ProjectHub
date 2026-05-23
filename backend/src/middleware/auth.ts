import type { FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify';
import type { GlobalRole, TeamRole } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';

// Verifies the bearer access token and attaches `request.user`.
// Deny-by-default: any route without `requireAuth` is public, so apply it explicitly.
export const requireAuth: preHandlerHookHandler = async (request, _reply) => {
  const header = request.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) throw Errors.unauthorized('Missing bearer token');
  const token = header.slice('Bearer '.length).trim();
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

// Asserts that the authenticated user has at least the given role in the team
// referenced by `:teamId` (path param). Returns the membership row for reuse.
export function requireTeamRole(...allowed: TeamRole[]): preHandlerHookHandler {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    if (!request.user) throw Errors.unauthorized();
    const teamId = (request.params as { teamId?: string } | undefined)?.teamId;
    if (!teamId) throw Errors.badRequest('Missing teamId in route');

    const membership = await prisma.teamMembership.findUnique({
      where: { userId_teamId: { userId: request.user.sub, teamId } },
    });
    if (!membership) throw Errors.forbidden('Not a team member');
    if (!allowed.includes(membership.role)) throw Errors.forbidden('Insufficient team role');

    (request as any).membership = membership;
  };
}

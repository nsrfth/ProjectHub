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

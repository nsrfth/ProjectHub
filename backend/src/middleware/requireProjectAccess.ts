import type { preHandlerHookHandler } from 'fastify';
import { Errors } from '../lib/errors.js';
import { userCanAccessProject } from '../lib/projectAccess.js';

// Project-visibility gate for /teams/:teamId/projects/:projectId/* nested routes.
// Delegates to userCanAccessProject(..., 'nested') so group grants and owners
// pass; project.edit managers do not.

export function requireProjectAccess(): preHandlerHookHandler {
  return async (request) => {
    if (!request.user) throw Errors.unauthorized();
    const params = request.params as { teamId?: string; projectId?: string };
    if (!params.teamId || !params.projectId) {
      throw Errors.internal(
        'requireProjectAccess installed on a route without :teamId / :projectId',
      );
    }

    const ok = await userCanAccessProject(
      params.projectId,
      params.teamId,
      request.user.sub,
      request.user.globalRole,
      'nested',
    );
    if (!ok) throw Errors.notFound('Project not found');
  };
}

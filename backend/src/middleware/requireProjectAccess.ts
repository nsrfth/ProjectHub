import type { preHandlerHookHandler } from 'fastify';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';

// v1.39 (BREAKING): project-visibility gate for every route nested under
// /teams/:teamId/projects/:projectId/*.
//
// Pre-v1.39 the route layer only checked team membership (requireTeamRole),
// which meant any team member could URL-guess `/projects/P/tasks` and
// reach a project they couldn't see in the projects list. With v1.39's
// projects-list filter (non-ADMIN sees only own projects), that bypass
// would have made the change cosmetic.
//
// Gate semantics — mirrors ProjectsService.assertCallerCanAccess:
//   - globalRole === 'ADMIN' → bypass (admin still requires the project
//     to actually exist in the named team).
//   - everyone else → require Project.ownerId === request.user.sub.
//   - any failure → 404, never 403 (no existence leak).
//
// Hook order: install AFTER requireAuth + requireTeamRole. Reads
// request.user (populated by requireAuth) and the {teamId, projectId} URL
// params. Hit is one Prisma findUnique per nested-route request — cheap.

export function requireProjectAccess(): preHandlerHookHandler {
  return async (request) => {
    if (!request.user) throw Errors.unauthorized();
    const params = request.params as { teamId?: string; projectId?: string };
    if (!params.teamId || !params.projectId) {
      throw Errors.internal(
        'requireProjectAccess installed on a route without :teamId / :projectId',
      );
    }

    const project = await prisma.project.findUnique({
      where: { id: params.projectId },
      select: { teamId: true, ownerId: true },
    });
    if (!project || project.teamId !== params.teamId) {
      throw Errors.notFound('Project not found');
    }
    if (request.user.globalRole === 'ADMIN') return;
    if (project.ownerId !== request.user.sub) {
      throw Errors.notFound('Project not found');
    }
  };
}

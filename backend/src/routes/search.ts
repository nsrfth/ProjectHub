import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { SearchService } from '../services/searchService.js';
import { SearchController } from '../controllers/searchController.js';
import { requireAuth } from '../middleware/auth.js';
import { requireScope } from '../middleware/requireScope.js';
import { searchQuery, searchResults } from '../schemas/search.js';

// v1.30: cross-team full-text search. Mounted at /api/search.
//
// Authz lives in the service: results are restricted to teams the caller
// is a member of. No `requireTeamRole` hook here — the endpoint is
// intentionally cross-team. `requireAuth` is the only gate.
export async function searchRoutes(app: FastifyInstance): Promise<void> {
  const svc = new SearchService();
  const ctrl = new SearchController(svc);
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  // v1.30.3 (S-2): cross-team search reads tasks, comments, and projects;
  // any read scope suffices because the per-bucket queries already
  // tenant-scope to teams the caller belongs to. We require `tasks:read`
  // as the broadest read scope — a token narrower than that (e.g.
  // `comments:read` only) shouldn't be poking the cross-entity surface.
  r.addHook('preHandler', requireScope('tasks:read'));

  r.get('/', {
    schema: {
      tags: ['search'],
      summary:
        'Full-text search across tasks, comments, and projects in the caller’s teams. ' +
        'Results are grouped by type, each bucket independently paginated by ' +
        '(ts_rank, id) keyset cursor. The `simple` Postgres text-search config ' +
        'is used because TaskHub content is heavily Persian.',
      querystring: searchQuery,
      response: { 200: searchResults },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.list,
  });
}

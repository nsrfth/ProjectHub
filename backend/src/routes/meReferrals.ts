import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { requireAuth } from '../middleware/auth.js';
import { requireScope } from '../middleware/requireScope.js';
import { Errors } from '../lib/errors.js';
import { myReferralsQuery, myReferralsResponse } from '../schemas/correspondence.js';
import { CorrespondenceService } from '../services/correspondenceService.js';

const svc = new CorrespondenceService();

// v2.5.26 (W2.2): cross-project "My referrals" inbox. User-scoped (mirrors
// meTasks): aggregates the caller's correspondence referrals across every team
// they belong to, excluding soft-deleted letters. Mounted under /api/me.
export async function meReferralsRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireScope('correspondence:read'));

  r.get('/referrals', {
    schema: {
      tags: ['me'],
      summary: 'Correspondence referrals for the current user across all teams',
      querystring: myReferralsQuery,
      response: { 200: myReferralsResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      if (!req.user) throw Errors.unauthorized();
      const items = await svc.listMyReferrals(req.user.sub, req.query);
      return reply.send({ items });
    },
  });
}

import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { AuditService } from '../services/auditService.js';
import { AuditController } from '../controllers/auditController.js';
import { requireAuth } from '../middleware/auth.js';
import { requireScope } from '../middleware/requireScope.js';
import { auditPage, auditQuery } from '../schemas/audit.js';

// Audit log read surface. Mounted at /api/audit. Authz is performed inside
// the service (ADMIN sees everything; MANAGER sees their teams only; MEMBER
// is rejected with 403) because the rule depends on dynamic team
// membership, not just the user's globalRole.
export async function auditRoutes(app: FastifyInstance): Promise<void> {
  const svc = new AuditService();
  const ctrl = new AuditController(svc);
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  // v1.30.3 (S-2): audit log is sensitive enough to require admin scope on
  // API tokens. The service-layer role gate still rejects MEMBER and
  // restricts MANAGER to their teams; the scope gate is additive.
  r.addHook('preHandler', requireScope('admin'));

  r.get('/', {
    schema: {
      tags: ['audit'],
      summary: 'Paginated activity log. ADMIN: instance-wide. MANAGER: their teams.',
      querystring: auditQuery,
      response: { 200: auditPage },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.list,
  });
}

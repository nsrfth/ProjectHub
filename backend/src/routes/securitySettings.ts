import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { SecuritySettingsController } from '../controllers/securitySettingsController.js';
import { requireAuth, requireGlobalAdmin } from '../middleware/auth.js';
import { requireScope } from '../middleware/requireScope.js';
import { passwordPolicyBody, passwordPolicyResponse } from '../schemas/passwordPolicy.js';

export async function securitySettingsRoutes(app: FastifyInstance): Promise<void> {
  const ctrl = new SecuritySettingsController();
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireGlobalAdmin);
  r.addHook('preHandler', requireScope('admin'));

  r.get('/password-policy', {
    schema: {
      tags: ['settings'],
      summary: 'Read local password policy (admin)',
      response: { 200: passwordPolicyResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.getPasswordPolicy,
  });

  r.put('/password-policy', {
    schema: {
      tags: ['settings'],
      summary: 'Update local password policy',
      body: passwordPolicyBody,
      response: { 200: passwordPolicyResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.updatePasswordPolicy,
  });
}

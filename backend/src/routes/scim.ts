import type { FastifyInstance } from 'fastify';
import { ScimController } from '../controllers/scimController.js';
import { requireScimAuth } from '../middleware/auth.js';
import { AppError } from '../lib/errors.js';
import { scimError } from '../lib/scim.js';

// SCIM 2.0 endpoints (RFC 7644). Mounted at /api/scim/v2.
//
// The discovery endpoints (ServiceProviderConfig, ResourceTypes, Schemas)
// are public per RFC §4 — IdPs hit them before they've been issued a token.
// /Users and /Groups require a valid SCIM Bearer credential.
//
// We install a route-scoped error handler so errors come back in SCIM
// envelope shape (`schemas: [.../Error]`) instead of TaskHub's normal JSON
// shape. IdPs validate the response shape and trip on anything else.
export async function scimRoutes(app: FastifyInstance): Promise<void> {
  const ctrl = new ScimController();

  app.setErrorHandler((err, _req, reply) => {
    const status =
      (err as AppError).statusCode ??
      (typeof (err as { statusCode?: unknown }).statusCode === 'number'
        ? Number((err as { statusCode?: unknown }).statusCode)
        : 500);
    const detail = err.message || 'Internal server error';
    return reply
      .code(status)
      .header('content-type', 'application/scim+json; charset=utf-8')
      .send(scimError(status, detail));
  });

  // ── Public discovery ─────────────────────────────────────────────────
  app.get('/ServiceProviderConfig', ctrl.serviceProviderConfig);
  app.get('/ResourceTypes', ctrl.resourceTypes);
  app.get('/Schemas', ctrl.schemas);

  // ── Authenticated resources ──────────────────────────────────────────
  app.register(async (auth) => {
    auth.addHook('preHandler', requireScimAuth);

    auth.get('/Users', ctrl.listUsers);
    auth.get('/Users/:id', ctrl.getUser);
    auth.post('/Users', ctrl.createUser);
    auth.put('/Users/:id', ctrl.replaceUser);
    auth.patch('/Users/:id', ctrl.patchUser);
    auth.delete('/Users/:id', ctrl.deleteUser);

    auth.get('/Groups', ctrl.listGroups);
    auth.get('/Groups/:id', ctrl.getGroup);
    auth.post('/Groups', ctrl.createGroup);
    auth.put('/Groups/:id', ctrl.replaceGroup);
    auth.patch('/Groups/:id', ctrl.patchGroup);
    auth.delete('/Groups/:id', ctrl.deleteGroup);
  });
}

import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ApiTokensService } from '../services/apiTokensService.js';
import { ApiTokensController } from '../controllers/apiTokensController.js';
import { requireAuth } from '../middleware/auth.js';
import { requireSessionAuth } from '../middleware/requireScope.js';
import {
  apiTokenCreateBody,
  apiTokenCreatedResponse,
  apiTokenIdParams,
  apiTokenListResponse,
} from '../schemas/apiTokens.js';

// Per-user API token CRUD. Mounted at /api/settings/api-tokens. The auth
// middleware already attaches request.user from either a JWT or a previous
// API token — this route doesn't care which.
export async function apiTokensRoutes(app: FastifyInstance): Promise<void> {
  const svc = new ApiTokensService();
  const ctrl = new ApiTokensController(svc);
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  // v1.30.3 (S-2): API tokens must NEVER be reachable from another API
  // token — not even a `*`-scoped one. This is a defence-in-depth gate
  // against a leaked wildcard token chaining itself into fresh
  // persistence tokens. The frontend uses a session-cookie + access
  // token; both produce a JWT, not an API token.
  r.addHook('preHandler', requireSessionAuth);

  r.get('/', {
    schema: {
      tags: ['api-tokens'],
      summary: 'List my API tokens (redacted)',
      response: { 200: apiTokenListResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.list,
  });

  r.post('/', {
    schema: {
      tags: ['api-tokens'],
      summary: 'Generate a new API token. The raw value is returned ONCE.',
      body: apiTokenCreateBody,
      response: { 201: apiTokenCreatedResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.create,
  });

  r.delete('/:tokenId', {
    schema: {
      tags: ['api-tokens'],
      summary: 'Revoke an API token',
      params: apiTokenIdParams,
      response: { 204: z.null() },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.revoke,
  });
}

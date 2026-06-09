import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { TaskhubController } from '../controllers/taskhubController.js';
import { requireAuth, requireGlobalAdmin } from '../middleware/auth.js';
import { requireScope } from '../middleware/requireScope.js';
import {
  pemUploadBody,
  sslInfoResponse,
  taskhubServerConfigResponse,
  taskhubServerUpdateBody,
} from '../schemas/taskhubServer.js';

export async function taskhubRoutes(app: FastifyInstance): Promise<void> {
  const ctrl = new TaskhubController();
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireGlobalAdmin);
  r.addHook('preHandler', requireScope('admin'));

  r.get('/server', {
    schema: {
      tags: ['settings'],
      summary: 'TaskHub server configuration (port, HTTPS intent)',
      response: { 200: taskhubServerConfigResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.getServer,
  });

  r.put('/server', {
    schema: {
      tags: ['settings'],
      summary: 'Update TaskHub server port / HTTPS settings',
      body: taskhubServerUpdateBody,
      response: { 200: taskhubServerConfigResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.updateServer,
  });

  r.get('/ssl', {
    schema: {
      tags: ['settings'],
      summary: 'SSL certificate metadata (never exposes private key)',
      response: { 200: sslInfoResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.getSsl,
  });

  r.post('/ssl/certificate', {
    schema: {
      tags: ['settings'],
      summary: 'Upload SSL certificate (PEM)',
      body: pemUploadBody,
      response: { 200: sslInfoResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.uploadCertificate,
  });

  r.post('/ssl/private-key', {
    schema: {
      tags: ['settings'],
      summary: 'Upload SSL private key (PEM) — never returned after upload',
      body: pemUploadBody,
      response: { 200: sslInfoResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.uploadPrivateKey,
  });

  r.post('/ssl/chain', {
    schema: {
      tags: ['settings'],
      summary: 'Upload intermediate certificate chain (PEM)',
      body: pemUploadBody,
      response: { 200: sslInfoResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.uploadChain,
  });
}

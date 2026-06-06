import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AttachmentsService } from '../services/attachmentsService.js';
import { AttachmentsController } from '../controllers/attachmentsController.js';
import { requireAuth, requireTeamRole } from '../middleware/auth.js';
import { requireScope } from '../middleware/requireScope.js';
import { attachmentResponse } from '../schemas/attachments.js';
import type { Env } from '../config/env.js';

// File uploads live under the task they belong to. Upload is one endpoint that
// accepts multipart/form-data and returns the attachment metadata.
export async function attachmentsRoutes(app: FastifyInstance, opts: { env: Env }): Promise<void> {
  const svc = new AttachmentsService(opts.env.UPLOAD_DIR);
  const ctrl = new AttachmentsController(svc);
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireTeamRole('MEMBER', 'MANAGER'));

  // No `body` schema on upload — multipart is parsed by @fastify/multipart in
  // the handler, not via Zod. Same reasoning as why the validator is omitted
  // on the auth refresh endpoint (cookie-based).
  r.post('/', {
    preHandler: requireScope('tasks:write'),
    schema: {
      tags: ['attachments'],
      summary: 'Upload a file to a task (multipart/form-data; single file)',
      params: z.object({ teamId: z.string(), projectId: z.string(), taskId: z.string() }),
      response: { 201: attachmentResponse },
      consumes: ['multipart/form-data'],
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.upload,
  });

  r.get('/', {
    preHandler: requireScope('tasks:read'),
    schema: {
      tags: ['attachments'],
      summary: 'List attachments on a task (metadata only — no blob)',
      params: z.object({ teamId: z.string(), projectId: z.string(), taskId: z.string() }),
      response: { 200: z.array(attachmentResponse) },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.list,
  });

  // Note: no Zod response schema here — the response is a binary stream, not
  // JSON, so the zod-type-provider serializer would mis-handle it.
  r.get('/:attachmentId/download', {
    preHandler: requireScope('tasks:read'),
    schema: {
      tags: ['attachments'],
      summary: 'Stream an attachment back to the client (forces download)',
      params: z.object({
        teamId: z.string(),
        projectId: z.string(),
        taskId: z.string(),
        attachmentId: z.string(),
      }),
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.download,
  });

  r.delete('/:attachmentId', {
    preHandler: requireScope('tasks:write'),
    schema: {
      tags: ['attachments'],
      summary: 'Delete an attachment (uploader OR team MANAGER)',
      params: z.object({
        teamId: z.string(),
        projectId: z.string(),
        taskId: z.string(),
        attachmentId: z.string(),
      }),
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.remove,
  });
}

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { BackupsService } from '../services/backupsService.js';
import { requireAuth, requireGlobalRole } from '../middleware/auth.js';
import { requireScope } from '../middleware/requireScope.js';
import {
  backupConfig,
  backupConfigPatch,
  backupFilenameParam,
  backupsPage,
  runBackupResponse,
} from '../schemas/backups.js';
import type { Env } from '../config/env.js';
import { Errors } from '../lib/errors.js';

// v1.27: backup admin endpoints. Admin-only, like the rest of /api/admin/*.
// Mounted at /api/admin/backups in app.ts.

export async function backupsRoutes(
  app: FastifyInstance,
  opts: { env: Env },
): Promise<void> {
  const svc = new BackupsService(opts.env.DATABASE_URL, opts.env.BACKUP_DIR);
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireGlobalRole('ADMIN'));
  // v1.30.3 (S-2): API tokens must carry the `admin` scope to touch
  // backup config or stored dumps.
  r.addHook('preHandler', requireScope('admin'));

  r.get('/', {
    schema: {
      tags: ['admin'],
      summary: 'List backups + current backup config (ADMIN only)',
      response: { 200: backupsPage },
      security: [{ bearerAuth: [] }],
    },
    handler: async (_req, reply) => {
      const [config, lastRunAt, items] = await Promise.all([
        svc.getConfig(),
        svc.getLastRunAt(),
        svc.list(),
      ]);
      const nextRunAt = lastRunAt
        ? new Date(lastRunAt.getTime() + config.intervalHours * 3600_000).toISOString()
        : null;
      return reply.send({
        config,
        lastRunAt: lastRunAt ? lastRunAt.toISOString() : null,
        nextRunAt,
        items,
      });
    },
  });

  r.put('/config', {
    schema: {
      tags: ['admin'],
      summary: 'Update backup config (ADMIN only). Period (hours) + retention (count) + on/off.',
      body: backupConfigPatch,
      response: { 200: backupConfig },
      security: [{ bearerAuth: [] }],
    },
    handler: async (req: FastifyRequest<{ Body: z.infer<typeof backupConfigPatch> }>, reply: FastifyReply) => {
      if (!req.user) throw Errors.unauthorized();
      const next = await svc.setConfig(req.body, req.user.sub);
      return reply.send(next);
    },
  });

  r.post('/run', {
    schema: {
      tags: ['admin'],
      summary: 'Run a backup now (ADMIN only). Streams pg_dump synchronously and returns when finished.',
      response: { 201: runBackupResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (_req, reply) => {
      const result = await svc.runBackup();
      return reply.status(201).send(result);
    },
  });

  r.get('/:filename/download', {
    schema: {
      tags: ['admin'],
      summary: 'Download a backup dump file (ADMIN only)',
      params: backupFilenameParam,
      security: [{ bearerAuth: [] }],
    },
    handler: async (
      req: FastifyRequest<{ Params: z.infer<typeof backupFilenameParam> }>,
      reply: FastifyReply,
    ) => {
      const file = await svc.openForDownload(req.params.filename);
      reply
        .header('Content-Type', 'application/octet-stream')
        .header('Content-Length', String(file.sizeBytes))
        .header('Content-Disposition', `attachment; filename="${file.filename}"`);
      return reply.send(file.stream);
    },
  });

  // v1.28: restore an existing dump. DESTRUCTIVE — pg_restore --clean --if-exists
  // drops + recreates the schema. Admin-only (the route hook already enforces
  // GlobalRole=ADMIN). The frontend wraps this in an explicit confirm dialog.
  r.post('/:filename/restore', {
    schema: {
      tags: ['admin'],
      summary: 'Restore a backup dump into the live database (ADMIN only, DESTRUCTIVE)',
      params: backupFilenameParam,
      response: {
        200: z.object({ filename: z.string(), durationMs: z.number().int().nonnegative() }),
      },
      security: [{ bearerAuth: [] }],
    },
    handler: async (
      req: FastifyRequest<{ Params: z.infer<typeof backupFilenameParam> }>,
      reply: FastifyReply,
    ) => {
      const result = await svc.restoreBackup(req.params.filename);
      return reply.send(result);
    },
  });

  // v1.28: stream an admin-uploaded .dump into BACKUP_DIR. Multipart/form-data,
  // single file. Override the global multipart fileSize limit (sized for task
  // attachments, default 10 MiB) with the BACKUP_UPLOAD_MAX_BYTES knob.
  r.post('/upload', {
    schema: {
      tags: ['admin'],
      summary: 'Upload a .dump (multipart/form-data, single file) for later restore.',
      consumes: ['multipart/form-data'],
      response: {
        201: z.object({
          filename: z.string(),
          sizeBytes: z.number().int().nonnegative(),
          createdAt: z.string(),
        }),
      },
      security: [{ bearerAuth: [] }],
    },
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const file = await req.file({ limits: { fileSize: opts.env.BACKUP_UPLOAD_MAX_BYTES } });
      if (!file) throw Errors.badRequest('Expected a multipart file upload');
      const saved = await svc.saveUpload({
        stream: file.file,
        originalName: file.filename || 'backup.dump',
        isTruncated: () => file.file.truncated,
      });
      return reply.status(201).send(saved);
    },
  });

  r.delete('/:filename', {
    schema: {
      tags: ['admin'],
      summary: 'Delete a backup dump file (ADMIN only)',
      params: backupFilenameParam,
      security: [{ bearerAuth: [] }],
    },
    handler: async (
      req: FastifyRequest<{ Params: z.infer<typeof backupFilenameParam> }>,
      reply: FastifyReply,
    ) => {
      await svc.deleteBackup(req.params.filename);
      return reply.status(204).send();
    },
  });
}

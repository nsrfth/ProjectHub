import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { BackupsService } from '../services/backupsService.js';
import { requireAuth, requireGlobalRole } from '../middleware/auth.js';
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

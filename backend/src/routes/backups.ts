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
  onlineBackupConfig,
  onlineBackupConfigPatch,
  runBackupResponse,
} from '../schemas/backups.js';
import type { Env } from '../config/env.js';
import { AppError, Errors } from '../lib/errors.js';
import { clearMaintenance, setMaintenance } from '../lib/maintenance.js';
import { _resetMaintenanceCache } from '../middleware/maintenance.js';

// v1.27: backup admin endpoints. Admin-only, like the rest of /api/admin/*.
// Mounted at /api/admin/backups in app.ts.

export async function backupsRoutes(
  app: FastifyInstance,
  opts: { env: Env },
): Promise<void> {
  // v1.32.3: bundle uploads + secrets into every scheduled backup so
  // cross-server restores carry attachment blobs and the encryption keys
  // for 2FA secrets / LDAP bind passwords. The restore endpoint surfaces
  // a secrets-sidecar path the operator hand-applies to .env.
  const svc = new BackupsService(opts.env.DATABASE_URL, opts.env.BACKUP_DIR, {
    uploadDir: opts.env.UPLOAD_DIR,
    secrets: {
      masterKey: opts.env.MASTER_KEY ?? null,
      jwtAccessSecret: opts.env.JWT_ACCESS_SECRET ?? null,
      jwtRefreshSecret: opts.env.JWT_REFRESH_SECRET ?? null,
    },
    // v2.5.36: online-backup status ping target.
    kopia: {
      url: opts.env.KOPIA_SERVER_URL ?? null,
      username: opts.env.KOPIA_SERVER_USERNAME ?? null,
      password: opts.env.KOPIA_SERVER_PASSWORD ?? null,
    },
  });
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
      const [config, lastRunAt, items, online, onlineStatus] = await Promise.all([
        svc.getConfig(),
        svc.getLastRunAt(),
        svc.list(),
        svc.getOnlineConfig(),
        svc.getOnlineStatus(),
      ]);
      const nextRunAt = lastRunAt
        ? new Date(lastRunAt.getTime() + config.intervalHours * 3600_000).toISOString()
        : null;
      return reply.send({
        config,
        lastRunAt: lastRunAt ? lastRunAt.toISOString() : null,
        nextRunAt,
        items,
        online,
        onlineStatus,
      });
    },
  });

  // v2.5.36: update the online backup (Kopia → Google Drive) policy.
  r.put('/online', {
    schema: {
      tags: ['admin'],
      summary: 'Update online backup config (ADMIN only) — Kopia → Google Drive policy.',
      body: onlineBackupConfigPatch,
      response: { 200: onlineBackupConfig },
      security: [{ bearerAuth: [] }],
    },
    handler: async (
      req: FastifyRequest<{ Body: z.infer<typeof onlineBackupConfigPatch> }>,
      reply: FastifyReply,
    ) => {
      if (!req.user) throw Errors.unauthorized();
      const next = await svc.setOnlineConfig(req.body, req.user.sub);
      return reply.send(next);
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
        // v1.32.3: bundled restores surface what landed (uploads / secrets)
        // so the UI can show the right "next step" hint to the admin.
        200: z.object({
          filename: z.string(),
          durationMs: z.number().int().nonnegative(),
          secretsApplied: z.boolean().default(false),
          secretsSidecar: z.string().nullable().default(null),
          uploadsRestored: z.boolean().default(false),
        }),
      },
      security: [{ bearerAuth: [] }],
    },
    handler: async (
      req: FastifyRequest<{ Params: z.infer<typeof backupFilenameParam> }>,
      reply: FastifyReply,
    ) => {
      if (!req.user) throw Errors.unauthorized();
      // v1.30.4 (S-5): orchestrated restore.
      //
      // Order:
      //   1. Set maintenance mode in the DB. The middleware caches for
      //      1s so a wave of in-flight requests doesn't hammer the
      //      pool while we're about to disconnect it; bust the cache
      //      manually so the very next request sees 503.
      //   2. Stop in-process schedulers. A TASK_DUE / RECURRENCE /
      //      BACKUP tick mid-restore would race the table drops.
      //   3. Run pg_restore (the service now uses --exit-on-error +
      //      strict exit-code handling; S-12).
      //   4a. On success: respond 200 with duration, then schedule a
      //       process.exit shortly after the response flushes. Compose
      //       restarts the container; the fresh boot's server.ts
      //       clears the maintenance setting.
      //   4b. On failure: clear maintenance + leave the schedulers off
      //       (caller can restart the container to recover them, or
      //       trigger another restore). Surface the pg_restore stderr
      //       verbatim in the 400 response so the admin can debug.
      const filename = req.params.filename;
      await setMaintenance(`restoring backup ${filename}`, req.user.sub);
      _resetMaintenanceCache();
      req.server.lifecycle.stopBackground();
      try {
        const result = await svc.restoreBackup(filename);
        // Respond first so the admin sees the success, THEN exit. Using
        // setImmediate lets the response flush before the listener
        // closes. A 250ms safety margin makes the test still pass with
        // a no-op processExit (which means the process keeps running
        // and the maint-mode flag persists across tests — the test
        // file resets it in beforeEach).
        reply.send(result);
        setTimeout(() => req.server.lifecycle.processExit(0), 250);
        return reply;
      } catch (err) {
        // Failure path — restore did NOT complete. Re-enable the app
        // for the admin who's about to investigate.
        await clearMaintenance();
        _resetMaintenanceCache();
        // Preserve the original status when the service threw a typed
        // AppError (e.g. notFound when the file is missing). Anything
        // else — pg_restore stderr captured by the service — becomes a
        // 400 so the admin sees the failure body verbatim.
        if (err instanceof AppError) throw err;
        const message = err instanceof Error ? err.message : 'pg_restore failed';
        throw Errors.badRequest(message);
      }
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

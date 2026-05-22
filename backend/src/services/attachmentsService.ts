import { createWriteStream } from 'node:fs';
import { mkdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { Prisma, type TeamRole } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';
import { ALLOWED_MIME_TYPES } from '../schemas/attachments.js';

// Attachments are stored on disk under an opaque server-generated `storageKey`
// — never under the user-supplied filename. This is the single most important
// security property of this module: it makes path-traversal payloads
// (`../etc/passwd`, etc.) inert because the filename never touches the
// filesystem path. The user-supplied filename only travels through:
//   - the DB (as the display name)
//   - the Content-Disposition header on download (sanitized)
//
// Files exceeding UPLOAD_MAX_BYTES are truncated mid-stream by @fastify/multipart;
// the upload handler checks `file.truncated` and rejects with 413, deleting
// the partial.

export interface AttachmentView {
  id: string;
  taskId: string;
  uploaderId: string;
  uploaderName: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: Date;
}

// What the controller needs to actually stream a download to the client.
export interface AttachmentDownload {
  storagePath: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export class AttachmentsService {
  constructor(private readonly uploadDir: string) {}

  private async ensureTaskInChain(teamId: string, projectId: string, taskId: string) {
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      select: { id: true, teamId: true, projectId: true },
    });
    if (!task || task.teamId !== teamId || task.projectId !== projectId) {
      throw Errors.notFound('Task not found');
    }
  }

  // Validates incoming file metadata, streams to disk, and inserts the DB row.
  // The caller (controller) is responsible for invoking this with the parsed
  // multipart file; this service treats the stream as opaque bytes.
  async upload(input: {
    teamId: string;
    projectId: string;
    taskId: string;
    uploaderId: string;
    filename: string;
    mimeType: string;
    stream: Readable;
    isTruncated: () => boolean;
  }): Promise<AttachmentView> {
    await this.ensureTaskInChain(input.teamId, input.projectId, input.taskId);

    if (!ALLOWED_MIME_TYPES.has(input.mimeType)) {
      throw Errors.badRequest(`Disallowed MIME type: ${input.mimeType}`);
    }

    // Random opaque key. cuid would also work, but a raw hex string makes the
    // "this is not a filename you can construct" intent obvious in the code.
    const storageKey = crypto.randomBytes(16).toString('hex');
    await mkdir(this.uploadDir, { recursive: true });
    const storagePath = path.join(this.uploadDir, storageKey);

    try {
      await pipeline(input.stream, createWriteStream(storagePath));
    } catch (err) {
      // Stream failed mid-write — clean up any partial file before bubbling.
      await unlink(storagePath).catch(() => undefined);
      throw err;
    }

    // @fastify/multipart streams up to `limits.fileSize` then truncates. We
    // check after the write to refuse oversize uploads. Clean up the partial.
    if (input.isTruncated()) {
      await unlink(storagePath).catch(() => undefined);
      throw Errors.badRequest('File exceeds size limit');
    }

    const { size } = await stat(storagePath);

    const row = await prisma.attachment.create({
      data: {
        taskId: input.taskId,
        uploaderId: input.uploaderId,
        filename: input.filename,
        storageKey,
        mimeType: input.mimeType,
        sizeBytes: size,
      },
      include: { uploader: { select: { name: true } } },
    });
    return {
      id: row.id,
      taskId: row.taskId,
      uploaderId: row.uploaderId,
      uploaderName: row.uploader.name,
      filename: row.filename,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      createdAt: row.createdAt,
    };
  }

  async list(teamId: string, projectId: string, taskId: string): Promise<AttachmentView[]> {
    await this.ensureTaskInChain(teamId, projectId, taskId);
    const rows = await prisma.attachment.findMany({
      where: { taskId },
      orderBy: { createdAt: 'desc' },
      include: { uploader: { select: { name: true } } },
    });
    return rows.map((a) => ({
      id: a.id,
      taskId: a.taskId,
      uploaderId: a.uploaderId,
      uploaderName: a.uploader.name,
      filename: a.filename,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
      createdAt: a.createdAt,
    }));
  }

  // Resolve an attachment for a download response. Re-checks the parent chain
  // AND that the resolved on-disk path is still inside UPLOAD_DIR — defense in
  // depth against a hypothetical bug that lets a non-opaque storageKey slip in.
  async getForDownload(
    teamId: string,
    projectId: string,
    taskId: string,
    attachmentId: string,
  ): Promise<AttachmentDownload> {
    await this.ensureTaskInChain(teamId, projectId, taskId);
    const att = await prisma.attachment.findUnique({ where: { id: attachmentId } });
    if (!att || att.taskId !== taskId) throw Errors.notFound('Attachment not found');

    const storagePath = path.resolve(this.uploadDir, att.storageKey);
    const rootResolved = path.resolve(this.uploadDir);
    if (!storagePath.startsWith(rootResolved + path.sep) && storagePath !== rootResolved) {
      throw Errors.internal('Storage path escaped upload root');
    }

    return {
      storagePath,
      filename: att.filename,
      mimeType: att.mimeType,
      sizeBytes: att.sizeBytes,
    };
  }

  async remove(
    teamId: string,
    projectId: string,
    taskId: string,
    attachmentId: string,
    callerId: string,
    callerRole: TeamRole,
  ): Promise<void> {
    await this.ensureTaskInChain(teamId, projectId, taskId);
    const att = await prisma.attachment.findUnique({ where: { id: attachmentId } });
    if (!att || att.taskId !== taskId) throw Errors.notFound('Attachment not found');
    if (att.uploaderId !== callerId && callerRole !== 'MANAGER') {
      throw Errors.forbidden('Only the uploader or a team MANAGER can delete this attachment');
    }

    try {
      await prisma.attachment.delete({ where: { id: attachmentId } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        throw Errors.notFound('Attachment not found');
      }
      throw err;
    }
    // Best-effort file cleanup. If the unlink fails the row is already gone;
    // we accept a small chance of an orphan blob on disk over a broken delete.
    const storagePath = path.resolve(this.uploadDir, att.storageKey);
    await unlink(storagePath).catch(() => undefined);
  }
}

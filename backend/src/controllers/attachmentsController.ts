import { createReadStream } from 'node:fs';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { TeamMembership } from '@prisma/client';
import type { AttachmentsService } from '../services/attachmentsService.js';
import { Errors } from '../lib/errors.js';

type TaskParams = { teamId: string; projectId: string; taskId: string };
type AttachmentParams = TaskParams & { attachmentId: string };

function callerMembership(req: FastifyRequest): TeamMembership {
  const m = (req as unknown as { membership?: TeamMembership }).membership;
  if (!m) throw Errors.internal('Missing team membership context');
  return m;
}

// Encode a user-supplied filename for the Content-Disposition header.
// RFC 5987 ext-value format covers non-ASCII; the ASCII fallback strips
// quotes and other characters that could break the header.
function dispositionFor(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export class AttachmentsController {
  constructor(private readonly svc: AttachmentsService) {}

  upload = async (req: FastifyRequest<{ Params: TaskParams }>, reply: FastifyReply) => {
    if (!req.user) throw Errors.unauthorized();

    // Single-file upload — `request.file()` returns the next multipart file or
    // undefined if the body isn't multipart / has no file field.
    const file = await req.file();
    if (!file) throw Errors.badRequest('Expected a multipart file upload');

    const attachment = await this.svc.upload({
      teamId: req.params.teamId,
      projectId: req.params.projectId,
      taskId: req.params.taskId,
      uploaderId: req.user.sub,
      filename: file.filename,
      mimeType: file.mimetype,
      stream: file.file,
      // Closure rather than passing the boolean — @fastify/multipart only sets
      // `file.truncated = true` AFTER the stream finishes, so we must capture
      // the file object and read the property post-upload.
      isTruncated: () => file.file.truncated,
    });

    return reply.status(201).send({
      ...attachment,
      createdAt: attachment.createdAt.toISOString(),
    });
  };

  list = async (req: FastifyRequest<{ Params: TaskParams }>, reply: FastifyReply) => {
    const items = await this.svc.list(req.params.teamId, req.params.projectId, req.params.taskId);
    return reply.send(items.map((a) => ({ ...a, createdAt: a.createdAt.toISOString() })));
  };

  download = async (req: FastifyRequest<{ Params: AttachmentParams }>, reply: FastifyReply) => {
    const dl = await this.svc.getForDownload(
      req.params.teamId,
      req.params.projectId,
      req.params.taskId,
      req.params.attachmentId,
    );

    // Pin the response Content-Type to what the DB says, not what the file's
    // bytes happen to start with — Helmet's nosniff header keeps the browser
    // from second-guessing us.
    reply.header('Content-Type', dl.mimeType);
    reply.header('Content-Length', String(dl.sizeBytes));
    reply.header('Content-Disposition', dispositionFor(dl.filename));
    return reply.send(createReadStream(dl.storagePath));
  };

  remove = async (req: FastifyRequest<{ Params: AttachmentParams }>, reply: FastifyReply) => {
    const m = callerMembership(req);
    await this.svc.remove(
      req.params.teamId,
      req.params.projectId,
      req.params.taskId,
      req.params.attachmentId,
      m.userId,
      m.role,
    );
    return reply.status(204).send();
  };
}

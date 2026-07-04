import { createReadStream } from 'node:fs';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { TeamMembership } from '@prisma/client';
import type {
  CorrespondenceService,
  CorrespondenceView,
  ReferralView,
} from '../services/correspondenceService.js';
import type { AttachmentsService, AttachmentView } from '../services/attachmentsService.js';
import type {
  CreateCorrespondenceBody,
  CreateLinkedTaskBody,
  ListCorrespondenceQuery,
  ReferBody,
  SetStatusBody,
  UpdateCorrespondenceBody,
} from '../schemas/correspondence.js';
import { Errors } from '../lib/errors.js';

type ProjectParams = { teamId: string; projectId: string };
type CorrespondenceParams = ProjectParams & { id: string };
type ReferralParams = CorrespondenceParams & { referralId: string };
type AttachmentParams = CorrespondenceParams & { attachmentId: string };

function callerMembership(req: FastifyRequest): TeamMembership {
  const m = (req as unknown as { membership?: TeamMembership }).membership;
  if (!m) throw Errors.internal('Missing team membership context');
  return m;
}

function dispositionFor(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function serializeReferral(r: ReferralView) {
  return {
    ...r,
    dueAt: r.dueAt ? r.dueAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
    handledAt: r.handledAt ? r.handledAt.toISOString() : null,
  };
}

function serializeContact(c: CorrespondenceView['sender']) {
  if (!c) return null;
  return {
    ...c,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

function serialize(c: CorrespondenceView) {
  return {
    id: c.id,
    teamId: c.teamId,
    projectId: c.projectId,
    direction: c.direction,
    subject: c.subject,
    body: c.body,
    letterDate: c.letterDate.toISOString(),
    jalaliYear: c.jalaliYear,
    sequence: c.sequence,
    referenceNumber: c.referenceNumber,
    status: c.status,
    senderId: c.senderId,
    recipientId: c.recipientId,
    sender: serializeContact(c.sender),
    recipient: serializeContact(c.recipient),
    createdById: c.createdById,
    referrals: c.referrals.map(serializeReferral),
    senderName: c.senderName,
    recipientName: c.recipientName,
    attachmentCount: c.attachmentCount,
    hasReferrals: c.hasReferrals,
    externalReferenceNumber: c.externalReferenceNumber,
    externalDate: c.externalDate ? c.externalDate.toISOString() : null,
    replyToId: c.replyToId,
    replyTo: c.replyTo,
    linkedTasks: c.linkedTasks,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

function serializeAttachment(a: AttachmentView) {
  return { ...a, createdAt: a.createdAt.toISOString() };
}

export class CorrespondenceController {
  constructor(
    private readonly svc: CorrespondenceService,
    private readonly attachments: AttachmentsService,
  ) {}

  list = async (
    req: FastifyRequest<{ Params: ProjectParams; Querystring: ListCorrespondenceQuery }>,
    reply: FastifyReply,
  ) => {
    const items = await this.svc.list(req.params.teamId, req.params.projectId, req.query);
    return reply.send(items.map(serialize));
  };

  get = async (req: FastifyRequest<{ Params: CorrespondenceParams }>, reply: FastifyReply) => {
    const c = await this.svc.get(req.params.teamId, req.params.projectId, req.params.id);
    return reply.send(serialize(c));
  };

  create = async (
    req: FastifyRequest<{ Params: ProjectParams; Body: CreateCorrespondenceBody }>,
    reply: FastifyReply,
  ) => {
    if (!req.user) throw Errors.unauthorized();
    const c = await this.svc.create(
      req.params.teamId,
      req.params.projectId,
      req.user.sub,
      req.user.globalRole,
      req.body,
    );
    return reply.status(201).send(serialize(c));
  };

  update = async (
    req: FastifyRequest<{ Params: CorrespondenceParams; Body: UpdateCorrespondenceBody }>,
    reply: FastifyReply,
  ) => {
    if (!req.user) throw Errors.unauthorized();
    const c = await this.svc.update(
      req.params.teamId,
      req.params.projectId,
      req.params.id,
      req.user.sub,
      req.user.globalRole,
      req.body,
    );
    return reply.send(serialize(c));
  };

  setStatus = async (
    req: FastifyRequest<{ Params: CorrespondenceParams; Body: SetStatusBody }>,
    reply: FastifyReply,
  ) => {
    if (!req.user) throw Errors.unauthorized();
    const c = await this.svc.setStatus(
      req.params.teamId,
      req.params.projectId,
      req.params.id,
      req.user.sub,
      req.user.globalRole,
      req.body.status,
    );
    return reply.send(serialize(c));
  };

  remove = async (req: FastifyRequest<{ Params: CorrespondenceParams }>, reply: FastifyReply) => {
    if (!req.user) throw Errors.unauthorized();
    await this.svc.remove(
      req.params.teamId,
      req.params.projectId,
      req.params.id,
      req.user.sub,
      req.user.globalRole,
    );
    return reply.status(204).send();
  };

  refer = async (
    req: FastifyRequest<{ Params: CorrespondenceParams; Body: ReferBody }>,
    reply: FastifyReply,
  ) => {
    if (!req.user) throw Errors.unauthorized();
    const c = await this.svc.refer(
      req.params.teamId,
      req.params.projectId,
      req.params.id,
      req.user.sub,
      req.user.globalRole,
      req.body,
    );
    return reply.status(201).send(serialize(c));
  };

  markReferralHandled = async (
    req: FastifyRequest<{ Params: ReferralParams }>,
    reply: FastifyReply,
  ) => {
    if (!req.user) throw Errors.unauthorized();
    const r = await this.svc.markReferralHandled(
      req.params.teamId,
      req.params.projectId,
      req.params.id,
      req.params.referralId,
      req.user.sub,
    );
    return reply.send(serializeReferral(r));
  };

  // --- Linked tasks (W2.2) ---------------------------------------------------

  linkTask = async (
    req: FastifyRequest<{ Params: CorrespondenceParams; Body: CreateLinkedTaskBody }>,
    reply: FastifyReply,
  ) => {
    if (!req.user) throw Errors.unauthorized();
    const items = await this.svc.linkTask(
      req.params.teamId,
      req.params.projectId,
      req.params.id,
      req.user.sub,
      req.user.globalRole,
      req.body,
    );
    return reply.status(201).send({ items });
  };

  listLinkedTasks = async (
    req: FastifyRequest<{ Params: CorrespondenceParams }>,
    reply: FastifyReply,
  ) => {
    const items = await this.svc.listLinkedTasks(
      req.params.teamId,
      req.params.projectId,
      req.params.id,
    );
    return reply.send({ items });
  };

  // --- Attachments (correspondence-scoped) ----------------------------------

  uploadAttachment = async (
    req: FastifyRequest<{ Params: CorrespondenceParams }>,
    reply: FastifyReply,
  ) => {
    if (!req.user) throw Errors.unauthorized();
    // Re-assert the letter exists + module is enabled before touching disk.
    await this.svc.get(req.params.teamId, req.params.projectId, req.params.id);

    const file = await req.file();
    if (!file) throw Errors.badRequest('Expected a multipart file upload');

    const att = await this.attachments.uploadToCorrespondence({
      teamId: req.params.teamId,
      projectId: req.params.projectId,
      correspondenceId: req.params.id,
      uploaderId: req.user.sub,
      filename: file.filename,
      mimeType: file.mimetype,
      stream: file.file,
      isTruncated: () => file.file.truncated,
    });
    return reply.status(201).send(serializeAttachment(att));
  };

  listAttachments = async (
    req: FastifyRequest<{ Params: CorrespondenceParams }>,
    reply: FastifyReply,
  ) => {
    const items = await this.attachments.listForCorrespondence(
      req.params.teamId,
      req.params.projectId,
      req.params.id,
    );
    return reply.send(items.map(serializeAttachment));
  };

  downloadAttachment = async (
    req: FastifyRequest<{ Params: AttachmentParams }>,
    reply: FastifyReply,
  ) => {
    const dl = await this.attachments.getForCorrespondenceDownload(
      req.params.teamId,
      req.params.projectId,
      req.params.id,
      req.params.attachmentId,
    );
    reply.header('Content-Type', dl.mimeType);
    reply.header('Content-Length', String(dl.sizeBytes));
    reply.header('Content-Disposition', dispositionFor(dl.filename));
    return reply.send(createReadStream(dl.storagePath));
  };

  removeAttachment = async (
    req: FastifyRequest<{ Params: AttachmentParams }>,
    reply: FastifyReply,
  ) => {
    const m = callerMembership(req);
    await this.attachments.removeFromCorrespondence(
      req.params.teamId,
      req.params.projectId,
      req.params.id,
      req.params.attachmentId,
      m.userId,
      m.role,
    );
    return reply.status(204).send();
  };
}

import type { GlobalRole, Prisma } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';
import {
  assertCanWriteProject,
  isUserEligibleTaskResponsible,
} from '../lib/projectAccess.js';
import { utcMidnightToJalali } from '../lib/shamsiCalendar.js';
import { logActivity } from './activityLogger.js';
import { notifications } from './notificationsService.js';
import type {
  CreateCorrespondenceBody,
  ListCorrespondenceQuery,
  ReferBody,
  UpdateCorrespondenceBody,
} from '../schemas/correspondence.js';

// v1.90: correspondence (دبیرخانه) — per-project register of formal letters.
//
// Module enablement (Project.correspondenceEnabled) is checked at the route
// layer via requireCorrespondenceEnabled AND re-asserted here (ensureModuleEnabled)
// so a service caller can never bypass it. Project WRITE access is enforced by
// the route preHandler for mutations and re-asserted via assertCanWriteProject.

type ContactView = {
  id: string;
  teamId: string;
  name: string;
  organization: string | null;
  email: string | null;
  phone: string | null;
  type: 'PERSON' | 'ORG';
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export interface ReferralView {
  id: string;
  correspondenceId: string;
  userId: string;
  userName: string | null;
  kind: 'ACTION' | 'INFO';
  note: string | null;
  status: 'PENDING' | 'HANDLED';
  referredById: string | null;
  createdAt: Date;
  handledAt: Date | null;
}

export interface CorrespondenceView {
  id: string;
  teamId: string;
  projectId: string;
  direction: 'INCOMING' | 'OUTGOING' | 'INTERNAL';
  subject: string;
  body: string | null;
  letterDate: Date;
  jalaliYear: number;
  sequence: number;
  referenceNumber: string;
  status: 'DRAFT' | 'SENT' | 'RECEIVED' | 'ARCHIVED';
  senderId: string | null;
  recipientId: string | null;
  sender: ContactView | null;
  recipient: ContactView | null;
  createdById: string | null;
  referrals: ReferralView[];
  // v1.90: flat convenience fields for the register/list UI.
  senderName: string | null;
  recipientName: string | null;
  attachmentCount: number;
  hasReferrals: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const correspondenceInclude = {
  sender: true,
  recipient: true,
  referrals: {
    orderBy: { createdAt: 'asc' as const },
    include: { user: { select: { name: true } } },
  },
  _count: { select: { attachments: true } },
} satisfies Prisma.CorrespondenceInclude;

type CorrespondenceRow = Prisma.CorrespondenceGetPayload<{ include: typeof correspondenceInclude }>;

function mapContact(c: CorrespondenceRow['sender']): ContactView | null {
  if (!c) return null;
  return {
    id: c.id,
    teamId: c.teamId,
    name: c.name,
    organization: c.organization,
    email: c.email,
    phone: c.phone,
    type: c.type,
    createdById: c.createdById,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

function mapReferral(r: CorrespondenceRow['referrals'][number]): ReferralView {
  return {
    id: r.id,
    correspondenceId: r.correspondenceId,
    userId: r.userId,
    userName: r.user?.name ?? null,
    kind: r.kind,
    note: r.note,
    status: r.status,
    referredById: r.referredById,
    createdAt: r.createdAt,
    handledAt: r.handledAt,
  };
}

function toView(row: CorrespondenceRow): CorrespondenceView {
  return {
    id: row.id,
    teamId: row.teamId,
    projectId: row.projectId,
    direction: row.direction,
    subject: row.subject,
    body: row.body,
    letterDate: row.letterDate,
    jalaliYear: row.jalaliYear,
    sequence: row.sequence,
    referenceNumber: row.referenceNumber,
    status: row.status,
    senderId: row.senderId,
    recipientId: row.recipientId,
    sender: mapContact(row.sender),
    recipient: mapContact(row.recipient),
    createdById: row.createdById,
    referrals: row.referrals.map(mapReferral),
    senderName: row.sender?.name ?? null,
    recipientName: row.recipient?.name ?? null,
    attachmentCount: row._count.attachments,
    hasReferrals: row.referrals.length > 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class CorrespondenceService {
  // Re-assert the module is enabled for this project. The route layer also
  // checks this, but a service caller (or a future code path) must never be
  // able to reach correspondence for a disabled project. 404 — the module
  // appears not to exist for that project.
  async ensureModuleEnabled(teamId: string, projectId: string): Promise<void> {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { teamId: true, correspondenceEnabled: true },
    });
    if (!project || project.teamId !== teamId || !project.correspondenceEnabled) {
      throw Errors.notFound('Project not found');
    }
  }

  // Validate a sender/recipient contact belongs to this team (and isn't
  // soft-deleted). undefined → leave unchanged; null → clear.
  private async assertContactInTeam(
    teamId: string,
    contactId: string | null | undefined,
  ): Promise<void> {
    if (!contactId) return;
    const c = await prisma.contact.findFirst({
      where: { id: contactId, teamId, deletedAt: null },
      select: { id: true },
    });
    if (!c) throw Errors.badRequest('Contact not found in this team');
  }

  async list(
    teamId: string,
    projectId: string,
    filters: ListCorrespondenceQuery = {},
  ): Promise<CorrespondenceView[]> {
    await this.ensureModuleEnabled(teamId, projectId);
    const where: Prisma.CorrespondenceWhereInput = { teamId, projectId, deletedAt: null };
    if (filters.direction) where.direction = filters.direction;
    if (filters.status) where.status = filters.status;
    if (filters.search) {
      where.OR = [
        { subject: { contains: filters.search, mode: 'insensitive' } },
        { referenceNumber: { contains: filters.search, mode: 'insensitive' } },
        { body: { contains: filters.search, mode: 'insensitive' } },
      ];
    }
    const rows = await prisma.correspondence.findMany({
      where,
      orderBy: [{ letterDate: 'desc' }, { sequence: 'desc' }],
      include: correspondenceInclude,
    });
    return rows.map(toView);
  }

  async get(teamId: string, projectId: string, id: string): Promise<CorrespondenceView> {
    await this.ensureModuleEnabled(teamId, projectId);
    const row = await prisma.correspondence.findFirst({
      where: { id, teamId, projectId, deletedAt: null },
      include: correspondenceInclude,
    });
    if (!row) throw Errors.notFound('Correspondence not found');
    return toView(row);
  }

  async create(
    teamId: string,
    projectId: string,
    actorId: string,
    actorGlobalRole: GlobalRole,
    body: CreateCorrespondenceBody,
  ): Promise<CorrespondenceView> {
    await this.ensureModuleEnabled(teamId, projectId);
    await assertCanWriteProject(projectId, teamId, actorId, actorGlobalRole);

    const letterDate = new Date(body.letterDate);
    await this.assertContactInTeam(teamId, body.senderId);
    await this.assertContactInTeam(teamId, body.recipientId);

    const { jy } = utcMidnightToJalali(letterDate);

    const row = await prisma.$transaction(async (tx) => {
      // The unique counter row serializes concurrent creates within a
      // (project, jalaliYear). upsert increments atomically; the unique
      // (projectId, jalaliYear, sequence) + (projectId, referenceNumber)
      // indexes make duplicate numbers impossible.
      const counter = await tx.correspondenceCounter.upsert({
        where: { projectId_jalaliYear: { projectId, jalaliYear: jy } },
        create: { projectId, jalaliYear: jy, currentValue: 1 },
        update: { currentValue: { increment: 1 } },
        select: { currentValue: true },
      });
      const sequence = counter.currentValue;
      const referenceNumber = `${jy}-${String(sequence).padStart(3, '0')}`;

      const created = await tx.correspondence.create({
        data: {
          teamId,
          projectId,
          direction: body.direction,
          subject: body.subject,
          body: body.body ?? null,
          letterDate,
          jalaliYear: jy,
          sequence,
          referenceNumber,
          status: body.status ?? 'DRAFT',
          senderId: body.senderId ?? null,
          recipientId: body.recipientId ?? null,
          createdById: actorId,
        },
        include: correspondenceInclude,
      });
      await logActivity(tx, {
        teamId,
        actorId,
        action: 'correspondence.created',
        meta: { correspondenceId: created.id, referenceNumber, projectId },
      });
      return created;
    });

    return toView(row);
  }

  async update(
    teamId: string,
    projectId: string,
    id: string,
    actorId: string,
    actorGlobalRole: GlobalRole,
    body: UpdateCorrespondenceBody,
  ): Promise<CorrespondenceView> {
    await this.ensureModuleEnabled(teamId, projectId);
    await assertCanWriteProject(projectId, teamId, actorId, actorGlobalRole);

    const existing = await prisma.correspondence.findFirst({
      where: { id, teamId, projectId, deletedAt: null },
      select: { id: true },
    });
    if (!existing) throw Errors.notFound('Correspondence not found');

    await this.assertContactInTeam(teamId, body.senderId);
    await this.assertContactInTeam(teamId, body.recipientId);

    // referenceNumber is PERMANENT — editing letterDate to another Jalali year
    // does NOT renumber. We deliberately do not touch jalaliYear/sequence/
    // referenceNumber on update.
    const row = await prisma.$transaction(async (tx) => {
      const updated = await tx.correspondence.update({
        where: { id },
        data: {
          ...(body.direction !== undefined && { direction: body.direction }),
          ...(body.subject !== undefined && { subject: body.subject }),
          ...(body.body !== undefined && { body: body.body }),
          ...(body.letterDate !== undefined && { letterDate: new Date(body.letterDate) }),
          ...(body.status !== undefined && { status: body.status }),
          ...(body.senderId !== undefined && { senderId: body.senderId }),
          ...(body.recipientId !== undefined && { recipientId: body.recipientId }),
        },
        include: correspondenceInclude,
      });
      await logActivity(tx, {
        teamId,
        actorId,
        action: 'correspondence.updated',
        meta: { correspondenceId: id, projectId },
      });
      return updated;
    });
    return toView(row);
  }

  async setStatus(
    teamId: string,
    projectId: string,
    id: string,
    actorId: string,
    actorGlobalRole: GlobalRole,
    status: 'DRAFT' | 'SENT' | 'RECEIVED' | 'ARCHIVED',
  ): Promise<CorrespondenceView> {
    await this.ensureModuleEnabled(teamId, projectId);
    await assertCanWriteProject(projectId, teamId, actorId, actorGlobalRole);

    const existing = await prisma.correspondence.findFirst({
      where: { id, teamId, projectId, deletedAt: null },
      select: { id: true, status: true },
    });
    if (!existing) throw Errors.notFound('Correspondence not found');

    const row = await prisma.$transaction(async (tx) => {
      const updated = await tx.correspondence.update({
        where: { id },
        data: { status },
        include: correspondenceInclude,
      });
      await logActivity(tx, {
        teamId,
        actorId,
        action: 'correspondence.status_changed',
        meta: { correspondenceId: id, from: existing.status, to: status, projectId },
      });
      return updated;
    });
    return toView(row);
  }

  async remove(
    teamId: string,
    projectId: string,
    id: string,
    actorId: string,
    actorGlobalRole: GlobalRole,
  ): Promise<void> {
    await this.ensureModuleEnabled(teamId, projectId);
    await assertCanWriteProject(projectId, teamId, actorId, actorGlobalRole);

    const existing = await prisma.correspondence.findFirst({
      where: { id, teamId, projectId, deletedAt: null },
      select: { id: true },
    });
    if (!existing) throw Errors.notFound('Correspondence not found');

    await prisma.$transaction(async (tx) => {
      await tx.correspondence.update({
        where: { id },
        data: { deletedAt: new Date(), deletedById: actorId },
      });
      await logActivity(tx, {
        teamId,
        actorId,
        action: 'correspondence.deleted',
        meta: { correspondenceId: id, projectId },
      });
    });
  }

  // Refer (ارجاع) a letter to team members. Each target is validated against
  // the project's eligible-responsible set (team members ∪ accepted group
  // grants). Re-referring an existing target resets it to PENDING (and may
  // change kind/note). Referred users get a CORRESPONDENCE_REFERRAL notification.
  async refer(
    teamId: string,
    projectId: string,
    id: string,
    actorId: string,
    actorGlobalRole: GlobalRole,
    body: ReferBody,
  ): Promise<CorrespondenceView> {
    await this.ensureModuleEnabled(teamId, projectId);
    await assertCanWriteProject(projectId, teamId, actorId, actorGlobalRole);

    const existing = await prisma.correspondence.findFirst({
      where: { id, teamId, projectId, deletedAt: null },
      select: { id: true, subject: true, referenceNumber: true },
    });
    if (!existing) throw Errors.notFound('Correspondence not found');

    // Dedupe by userId (last wins).
    const byUser = new Map<string, { userId: string; kind: 'ACTION' | 'INFO'; note: string | null }>();
    for (const t of body.targets) {
      byUser.set(t.userId, { userId: t.userId, kind: t.kind ?? 'ACTION', note: t.note ?? null });
    }
    const targets = [...byUser.values()];

    for (const t of targets) {
      const eligible = await isUserEligibleTaskResponsible(teamId, projectId, t.userId);
      if (!eligible) {
        throw Errors.badRequest('Referral target is not eligible for this project');
      }
    }

    const row = await prisma.$transaction(async (tx) => {
      for (const t of targets) {
        // Re-refer resets to PENDING + clears handledAt.
        await tx.correspondenceReferral.upsert({
          where: { correspondenceId_userId: { correspondenceId: id, userId: t.userId } },
          create: {
            correspondenceId: id,
            teamId,
            userId: t.userId,
            kind: t.kind,
            note: t.note,
            status: 'PENDING',
            referredById: actorId,
          },
          update: {
            kind: t.kind,
            note: t.note,
            status: 'PENDING',
            handledAt: null,
            referredById: actorId,
          },
        });
      }
      await logActivity(tx, {
        teamId,
        actorId,
        action: 'correspondence.referred',
        meta: {
          correspondenceId: id,
          projectId,
          userIds: targets.map((t) => t.userId),
        },
      });
      await notifications.onCorrespondenceReferral(tx, {
        teamId,
        projectId,
        correspondenceId: id,
        referenceNumber: existing.referenceNumber,
        subject: existing.subject,
        actorId,
        recipients: targets.map((t) => ({ userId: t.userId, kind: t.kind })),
      });

      return tx.correspondence.findUniqueOrThrow({
        where: { id },
        include: correspondenceInclude,
      });
    });
    return toView(row);
  }

  // Mark the CALLER's own referral handled. Gated by referral ownership, NOT
  // project write — a referred member with read-only access can still mark
  // their own action done. The route layer does not require project write.
  async markReferralHandled(
    teamId: string,
    projectId: string,
    id: string,
    referralId: string,
    actorId: string,
  ): Promise<ReferralView> {
    await this.ensureModuleEnabled(teamId, projectId);

    const correspondence = await prisma.correspondence.findFirst({
      where: { id, teamId, projectId, deletedAt: null },
      select: { id: true },
    });
    if (!correspondence) throw Errors.notFound('Correspondence not found');

    const referral = await prisma.correspondenceReferral.findFirst({
      where: { id: referralId, correspondenceId: id },
      include: { user: { select: { name: true } } },
    });
    if (!referral) throw Errors.notFound('Referral not found');
    if (referral.userId !== actorId) {
      throw Errors.forbidden('Only the referred user can mark this referral handled');
    }

    const updated = await prisma.correspondenceReferral.update({
      where: { id: referralId },
      data: { status: 'HANDLED', handledAt: new Date() },
      include: { user: { select: { name: true } } },
    });
    return mapReferral(updated);
  }
}

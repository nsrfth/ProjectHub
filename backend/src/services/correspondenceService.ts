import { Prisma, type GlobalRole } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors, AppError } from '../lib/errors.js';
import {
  assertCanWriteProject,
  isUserEligibleTaskResponsible,
} from '../lib/projectAccess.js';
import { utcMidnightToJalali } from '../lib/shamsiCalendar.js';
import { logActivity } from './activityLogger.js';
import { notifications } from './notificationsService.js';
import { TasksService } from './tasksService.js';
import type {
  CreateCorrespondenceBody,
  CreateLinkedTaskBody,
  LinkedTaskItem,
  ListCorrespondenceQuery,
  MyReferralItem,
  MyReferralsQuery,
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
  dueAt: Date | null;
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
  externalReferenceNumber: string | null;
  externalDate: Date | null;
  replyToId: string | null;
  replyTo: { id: string; referenceNumber: string; subject: string } | null;
  linkedTasks: { taskId: string; title: string; status: string }[];
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
  // v2.5.26 (W2.2): parent-letter summary + linked tasks.
  replyTo: { select: { id: true, referenceNumber: true, subject: true } },
  linkedTasks: {
    orderBy: { createdAt: 'asc' as const },
    include: { task: { select: { id: true, title: true, status: true } } },
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
    dueAt: r.dueAt,
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
    externalReferenceNumber: row.externalReferenceNumber,
    externalDate: row.externalDate,
    replyToId: row.replyToId,
    replyTo: row.replyTo
      ? { id: row.replyTo.id, referenceNumber: row.replyTo.referenceNumber, subject: row.replyTo.subject }
      : null,
    linkedTasks: row.linkedTasks.map((l) => ({
      taskId: l.task.id,
      title: l.task.title,
      status: l.task.status,
    })),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class CorrespondenceService {
  // W2.2: create-and-link goes through the existing task service (WBS path,
  // denormalized teamId, activity log) rather than a raw prisma insert.
  private readonly tasks = new TasksService();

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
  ): Promise<{ items: CorrespondenceView[]; nextCursor: string | null }> {
    await this.ensureModuleEnabled(teamId, projectId);
    const limit = filters.limit ?? 50;
    const where: Prisma.CorrespondenceWhereInput = { teamId, projectId, deletedAt: null };
    if (filters.direction) where.direction = filters.direction;
    if (filters.status) where.status = filters.status;

    // v2.5.30 (W2.3): full-text search via the generated tsvector column.
    // Prisma's typed `where` can't express `@@`, so resolve matching ids with a
    // tiny raw query (config 'simple', websearch syntax) and constrain by them.
    // Everything else — ordering, cursor pagination — stays in the typed client.
    if (filters.search) {
      const matches = await prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Correspondence"
        WHERE "teamId" = ${teamId} AND "projectId" = ${projectId} AND "deletedAt" IS NULL
          AND "searchVector" @@ websearch_to_tsquery('simple', ${filters.search})`;
      where.id = { in: matches.map((m) => m.id) };
    }

    // Keyset pagination: stable total order (letterDate desc, id desc) with id as
    // the unique tiebreaker Prisma's cursor rides on. Fetch limit+1 to detect more.
    const rows = await prisma.correspondence.findMany({
      where,
      orderBy: [{ letterDate: 'desc' }, { id: 'desc' }],
      include: correspondenceInclude,
      take: limit + 1,
      ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: page.map(toView),
      nextCursor: hasMore ? page[page.length - 1]!.id : null,
    };
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

    const row = await this.createWithSequence(tx =>
      this.insertLetter(tx, { teamId, projectId, actorId, jy, letterDate, body }),
    );

    return toView(row);
  }

  // v2.5.25 (W2.1): sequence assignment is already atomic — the
  // CorrespondenceCounter upsert compiles to INSERT ... ON CONFLICT DO UPDATE,
  // so concurrent creates serialize on the counter row and get distinct
  // sequences (the "assigns distinct reference numbers under concurrency" test
  // proves it). This bounded retry is DEFENSE-IN-DEPTH: should that atomic
  // guarantee ever be violated (a Prisma change, a raw-SQL path, or manual
  // counter tampering), recompute the number rather than surface a raw P2002,
  // and after a few attempts return a stable 409 instead of a 500. The
  // considered-and-rejected alternative was pg_advisory_xact_lock — stronger,
  // but retry is idiomatic here and the (already-tiny) contention window makes
  // the extra lock unnecessary.
  private async createWithSequence(
    work: (tx: Prisma.TransactionClient) => Promise<CorrespondenceRow>,
  ): Promise<CorrespondenceRow> {
    const MAX_RETRIES = 3;
    for (let attempt = 0; ; attempt++) {
      try {
        return await prisma.$transaction(work);
      } catch (err) {
        const isSeqConflict =
          err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
        if (isSeqConflict && attempt < MAX_RETRIES) continue;
        if (isSeqConflict) {
          throw new AppError(
            409,
            'CORRESPONDENCE_SEQUENCE_CONFLICT',
            'Could not assign a correspondence reference number under contention; please retry.',
          );
        }
        throw err;
      }
    }
  }

  private async insertLetter(
    tx: Prisma.TransactionClient,
    args: {
      teamId: string;
      projectId: string;
      actorId: string;
      jy: number;
      letterDate: Date;
      body: CreateCorrespondenceBody;
    },
  ): Promise<CorrespondenceRow> {
    const { teamId, projectId, actorId, jy, letterDate, body } = args;
    if (body.replyToId) await this.assertReplyToInProject(projectId, body.replyToId);
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
        externalReferenceNumber: body.externalReferenceNumber ?? null,
        externalDate: body.externalDate ? new Date(body.externalDate) : null,
        replyToId: body.replyToId ?? null,
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
    // W2.2: a reply-to must be another (non-deleted) letter in the SAME project,
    // and never the letter itself.
    if (body.replyToId) {
      if (body.replyToId === id) {
        throw new AppError(400, 'CORRESPONDENCE_REPLY_TO_INVALID', 'A letter cannot reply to itself.');
      }
      await this.assertReplyToInProject(projectId, body.replyToId);
    }

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
          ...(body.externalReferenceNumber !== undefined && {
            externalReferenceNumber: body.externalReferenceNumber,
          }),
          ...(body.externalDate !== undefined && {
            externalDate: body.externalDate ? new Date(body.externalDate) : null,
          }),
          ...(body.replyToId !== undefined && { replyToId: body.replyToId }),
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
  // W2.2: a reply-to must reference an existing, non-deleted letter in the SAME
  // project (never cross-project). Read via prisma (a simple existence check).
  private async assertReplyToInProject(projectId: string, replyToId: string): Promise<void> {
    const parent = await prisma.correspondence.findFirst({
      where: { id: replyToId, projectId, deletedAt: null },
      select: { id: true },
    });
    if (!parent) {
      throw new AppError(
        400,
        'CORRESPONDENCE_REPLY_TO_INVALID',
        'The reply-to letter must be an existing, non-deleted letter in the same project.',
      );
    }
  }

  // W2.2: create a task in the letter's project (via the task service) and link
  // it to the letter. Needs project WRITE (the service re-asserts). Returns the
  // letter's full linked-task list.
  async linkTask(
    teamId: string,
    projectId: string,
    id: string,
    actorId: string,
    actorGlobalRole: GlobalRole,
    body: CreateLinkedTaskBody,
  ): Promise<LinkedTaskItem[]> {
    await this.ensureModuleEnabled(teamId, projectId);
    await assertCanWriteProject(projectId, teamId, actorId, actorGlobalRole);
    const letter = await prisma.correspondence.findFirst({
      where: { id, teamId, projectId, deletedAt: null },
      select: { id: true },
    });
    if (!letter) throw Errors.notFound('Correspondence not found');

    const task = await this.tasks.create(teamId, projectId, actorId, actorGlobalRole, {
      title: body.title,
      description: body.description ?? undefined,
      priority: body.priority,
      dueDate: body.dueDate ?? undefined,
      assigneeId: body.assigneeId ?? undefined,
    });
    await prisma.correspondenceTask.create({
      data: { correspondenceId: id, taskId: task.id, createdById: actorId },
    });
    await logActivity(prisma, {
      teamId,
      actorId,
      action: 'correspondence.task_linked',
      meta: { correspondenceId: id, taskId: task.id, projectId },
    });
    return this.listLinkedTasks(teamId, projectId, id);
  }

  async listLinkedTasks(teamId: string, projectId: string, id: string): Promise<LinkedTaskItem[]> {
    await this.ensureModuleEnabled(teamId, projectId);
    const letter = await prisma.correspondence.findFirst({
      where: { id, teamId, projectId, deletedAt: null },
      select: { id: true },
    });
    if (!letter) throw Errors.notFound('Correspondence not found');
    const links = await prisma.correspondenceTask.findMany({
      where: { correspondenceId: id },
      orderBy: { createdAt: 'asc' },
      include: { task: { select: { id: true, title: true, status: true } } },
    });
    return links.map((l) => ({ taskId: l.task.id, title: l.task.title, status: l.task.status }));
  }

  // W2.2: cross-project "My referrals" inbox. User-scoped (not team-scoped):
  // constrained to the caller's team memberships, excluding soft-deleted letters.
  async listMyReferrals(userId: string, query: MyReferralsQuery): Promise<MyReferralItem[]> {
    const memberships = await prisma.teamMembership.findMany({
      where: { userId },
      select: { teamId: true },
    });
    const teamIds = memberships.map((m) => m.teamId);
    if (teamIds.length === 0) return [];

    const where: Prisma.CorrespondenceReferralWhereInput = {
      userId,
      teamId: { in: teamIds },
      correspondence: { deletedAt: null },
      ...(query.status && { status: query.status }),
    };
    if (query.due === 'overdue') {
      // dueAt < now (Prisma treats null as not-less-than, so nulls drop out).
      where.dueAt = { lt: new Date() };
    } else if (query.due === 'week') {
      const now = new Date();
      where.dueAt = { gte: now, lte: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000) };
    }

    const rows = await prisma.correspondenceReferral.findMany({
      where,
      orderBy: [{ dueAt: 'asc' }, { createdAt: 'desc' }],
      include: {
        correspondence: {
          select: {
            id: true,
            teamId: true,
            projectId: true,
            referenceNumber: true,
            subject: true,
            direction: true,
            letterDate: true,
          },
        },
      },
    });

    return rows.map((r) => ({
      id: r.id,
      correspondenceId: r.correspondenceId,
      kind: r.kind,
      note: r.note,
      status: r.status,
      dueAt: r.dueAt ? r.dueAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
      handledAt: r.handledAt ? r.handledAt.toISOString() : null,
      teamId: r.correspondence.teamId,
      projectId: r.correspondence.projectId,
      referenceNumber: r.correspondence.referenceNumber,
      subject: r.correspondence.subject,
      direction: r.correspondence.direction,
      letterDate: r.correspondence.letterDate.toISOString(),
    }));
  }

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
    const byUser = new Map<
      string,
      { userId: string; kind: 'ACTION' | 'INFO'; note: string | null; dueAt: Date | null }
    >();
    for (const t of body.targets) {
      byUser.set(t.userId, {
        userId: t.userId,
        kind: t.kind ?? 'ACTION',
        note: t.note ?? null,
        dueAt: t.dueAt ? new Date(t.dueAt) : null,
      });
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
            dueAt: t.dueAt,
            status: 'PENDING',
            referredById: actorId,
          },
          update: {
            kind: t.kind,
            note: t.note,
            dueAt: t.dueAt,
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

import type { GlobalRole, Prisma, TaskAssignmentRequest } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';
import { loadEnv } from '../config/env.js';
import { classifyAssignmentBoundary } from '../lib/assignmentBoundary.js';
import { WorkingDayCalendar } from '../lib/workingDays.js';
import { notificationsHub } from './notificationsHub.js';

// v-next (cross-unit task assignment workflow), Slice 5. The request → approval →
// delegated-assignment lifecycle. See docs/ASSIGNMENT_WORKFLOW.md §6.
//
// Owns its OWN status lifecycle (no shared Approval table — the codebase keeps
// each workflow's states its own). Unrelated to Task.approverId (v1.87
// completion gate). Every method re-asserts the task↔project↔team tenancy chain
// and gates on the caller's identity — the decision routes carry NO project-
// access hook (a cross-division approver has none), so THIS is the gate.

const SLA_WORKING_DAYS = 3; // D5 default

/** Best-effort in-app notification (mirrors projectGrantsService.notify). */
async function notify(
  userId: string,
  teamId: string | null,
  type: 'ASSIGNMENT_REQUESTED' | 'ASSIGNMENT_DECIDED',
  payload: Prisma.InputJsonValue,
): Promise<void> {
  try {
    await prisma.notification.create({ data: { userId, teamId, type, payload } });
    notificationsHub.publish(userId, { type: 'notification:new', id: '' });
  } catch {
    // Notifications are best-effort everywhere here; a decision must never fail
    // because its announcement did.
  }
}

// v-next (P2): the approver inbox is a cross-project surface, so it carries the
// display names the UI needs (bare ids would force N follow-up lookups client
// side). Mirrors PendingApproval on the grants inbox.
export interface AssignmentApprovalView {
  id: string;
  status: TaskAssignmentRequest['status'];
  taskId: string;
  taskTitle: string;
  projectId: string;
  projectName: string;
  teamId: string;
  requesterId: string;
  requesterName: string;
  proposedId: string | null;
  proposedName: string | null;
  targetType: TaskAssignmentRequest['targetType'];
  targetId: string;
  expiresAt: string;
  createdAt: string;
}

export class AssignmentRequestsService {
  /**
   * The requester hit ASSIGNMENT_REQUEST_REQUIRED on a direct assign and now
   * files the request. `proposedId` is the person they wanted (advisory — the
   * approver confirms or overrides). We classify that person to derive the
   * target unit/division and the approver, then D4-block if no approver exists.
   */
  async create(
    teamId: string,
    projectId: string,
    taskId: string,
    requesterId: string,
    input: { proposedId: string },
  ): Promise<TaskAssignmentRequest> {
    if (!loadEnv().TASK_ASSIGNMENT_WORKFLOW) throw Errors.badRequest('Assignment workflow is disabled');
    const task = await this.assertTaskInProjectTeam(teamId, projectId, taskId);

    const boundary = await classifyAssignmentBoundary({
      projectTeamId: teamId,
      requesterUserId: requesterId,
      targetUserId: input.proposedId,
    });
    if (boundary.scenario === 'A') {
      // No boundary crossed — the direct assign would have succeeded; a request
      // is meaningless. (Guards against a client that requests unconditionally.)
      throw Errors.badRequest('This person is assignable directly — no request needed');
    }

    const targetType = boundary.scenario === 'B' ? 'GROUP' : 'TEAM';
    const targetId = boundary.scenario === 'B' ? boundary.targetGroupId : boundary.targetTeamId;

    // D4: a target unit/division with no manager cannot approve — surface the
    // config problem at creation rather than creating an unapprovable request.
    const approvers = await this.resolveApprovers(targetType, targetId);
    if (approvers.length === 0) {
      throw Errors.badRequest(
        targetType === 'GROUP'
          ? 'The target department has no manager to approve — designate one first'
          : 'The target division has no deputy to approve — designate one first',
      );
    }

    const cal = await WorkingDayCalendar.load();
    const expiresAt = cal.addWorkingDays(new Date(), SLA_WORKING_DAYS);

    const req = await prisma.taskAssignmentRequest.create({
      data: {
        teamId,
        taskId,
        projectId,
        requesterId,
        targetType,
        targetId,
        proposedId: input.proposedId,
        status: 'REQUESTED',
        expiresAt,
      },
    });

    for (const uid of approvers) {
      await notify(uid, teamId, 'ASSIGNMENT_REQUESTED', {
        requestId: req.id,
        taskId,
        projectId,
        taskTitle: task.title,
        requesterId,
        proposedId: input.proposedId,
      });
    }
    return req;
  }

  /** REQUESTED → APPROVED. Approver only. Records intent; assignee chosen next. */
  async approve(requestId: string, actorId: string): Promise<TaskAssignmentRequest> {
    const req = await this.load(requestId);
    this.assertPending(req, ['REQUESTED']);
    await this.assertApprover(req, actorId);
    const updated = await prisma.taskAssignmentRequest.update({
      where: { id: req.id },
      data: { status: 'APPROVED', approverId: actorId },
    });
    await notify(req.requesterId, req.teamId, 'ASSIGNMENT_DECIDED', {
      requestId: req.id, taskId: req.taskId, decision: 'approved',
    });
    return updated;
  }

  /**
   * Scenario C only: a deputy delegates (ابلاغ) the request to one of their
   * department managers, who will select the assignee. APPROVED → FORWARDED.
   */
  async forward(
    requestId: string,
    actorId: string,
    toDeptManagerId: string,
  ): Promise<TaskAssignmentRequest> {
    const req = await this.load(requestId);
    if (req.targetType !== 'TEAM') throw Errors.badRequest('Only cross-division requests can be forwarded');
    this.assertPending(req, ['REQUESTED', 'APPROVED']);
    await this.assertApprover(req, actorId);
    // The delegate must be a department MANAGER within the target division.
    const isDeptManager = await prisma.userGroupMember.findFirst({
      where: {
        userId: toDeptManagerId,
        teamId: req.targetId,
        isUnit: true,
        role: 'MANAGER',
        status: 'ACCEPTED',
      },
      select: { id: true },
    });
    if (!isDeptManager) throw Errors.badRequest('Forward target is not a department manager in this division');
    const updated = await prisma.taskAssignmentRequest.update({
      where: { id: req.id },
      data: { status: 'FORWARDED', approverId: actorId, forwardedToId: toDeptManagerId },
    });
    await notify(toDeptManagerId, req.teamId, 'ASSIGNMENT_REQUESTED', {
      requestId: req.id, taskId: req.taskId, projectId: req.projectId, forwarded: true,
    });
    return updated;
  }

  /**
   * Terminal. Approver (B), deputy (C-direct), or the forwarded manager
   * (C-delegated) selects the final assignee. Sets Task.assigneeId directly
   * (bypassing the boundary guard — THIS is the approved path) and auto-issues
   * the project-scoped USER grant (D3: WRITE, provenance source). One tx.
   */
  async assign(requestId: string, actorId: string, assigneeId: string): Promise<TaskAssignmentRequest> {
    const req = await this.load(requestId);
    this.assertPending(req, ['REQUESTED', 'APPROVED', 'FORWARDED']);
    await this.assertApprover(req, actorId);
    await this.assertTaskInProjectTeam(req.teamId, req.projectId, req.taskId);
    await this.assertAssigneeWithinTarget(req, assigneeId);

    const updated = await prisma.$transaction(async (tx) => {
      await tx.task.update({ where: { id: req.taskId }, data: { assigneeId } });
      // Auto-grant: project-scoped USER grant at WRITE (D3). higher-wins dedup —
      // a no-op when an equal/greater grant already exists. `source` is
      // provenance only; reversal is reference-counted (Slice 6), never by tag.
      await tx.projectAccessGrant.upsert({
        where: {
          projectId_subjectType_subjectId_level: {
            projectId: req.projectId, subjectType: 'USER', subjectId: assigneeId, level: 'WRITE',
          },
        },
        update: { status: 'ACTIVE' },
        create: {
          projectId: req.projectId,
          subjectType: 'USER',
          subjectId: assigneeId,
          level: 'WRITE',
          status: 'ACTIVE',
          source: `assignment:${req.id}`,
        },
      });
      return tx.taskAssignmentRequest.update({
        where: { id: req.id },
        data: { status: 'ASSIGNED', assigneeId, approverId: actorId, decidedAt: new Date() },
      });
    });

    await notify(req.requesterId, req.teamId, 'ASSIGNMENT_DECIDED', {
      requestId: req.id, taskId: req.taskId, decision: 'assigned', assigneeId,
    });
    // Also tell the assignee, matching the normal TASK_ASSIGNED behaviour.
    await notify(assigneeId, req.teamId, 'ASSIGNMENT_DECIDED', {
      requestId: req.id, taskId: req.taskId, decision: 'assigned_to_you',
    });
    return updated;
  }

  /** Any non-terminal state → DECLINED. Approver only; reason required. */
  async decline(requestId: string, actorId: string, reason: string): Promise<TaskAssignmentRequest> {
    const req = await this.load(requestId);
    this.assertPending(req, ['REQUESTED', 'APPROVED', 'FORWARDED']);
    await this.assertApprover(req, actorId);
    if (!reason.trim()) throw Errors.badRequest('A decline reason is required');
    const updated = await prisma.taskAssignmentRequest.update({
      where: { id: req.id },
      data: { status: 'DECLINED', approverId: actorId, declineReason: reason, decidedAt: new Date() },
    });
    await notify(req.requesterId, req.teamId, 'ASSIGNMENT_DECIDED', {
      requestId: req.id, taskId: req.taskId, decision: 'declined', reason,
    });
    return updated;
  }

  /** The caller's approval inbox — every request they may decide, any team. */
  async listMyApprovals(actorId: string): Promise<AssignmentApprovalView[]> {
    // Department groups where the actor is a MANAGER (scenario B targets).
    const managedUnits = await prisma.userGroupMember.findMany({
      where: { userId: actorId, isUnit: true, role: 'MANAGER', status: 'ACCEPTED' },
      select: { groupId: true },
    });
    const managedGroupIds = managedUnits.map((u) => u.groupId);
    // Divisions where the actor is a deputy (manager) — scenario C targets.
    const deputyTeamIds = await this.teamsWhereManager(actorId);

    const rows = await prisma.taskAssignmentRequest.findMany({
      where: {
        status: { in: ['REQUESTED', 'APPROVED', 'FORWARDED'] },
        OR: [
          managedGroupIds.length ? { targetType: 'GROUP', targetId: { in: managedGroupIds } } : undefined,
          deputyTeamIds.length ? { targetType: 'TEAM', targetId: { in: deputyTeamIds } } : undefined,
          // Requests forwarded specifically to this dept manager.
          { forwardedToId: actorId, status: 'FORWARDED' },
        ].filter(Boolean) as Prisma.TaskAssignmentRequestWhereInput[],
      },
      include: { task: { select: { title: true } }, project: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    });

    // Batch the requester/proposed display names (bare-FK subjects, no relation).
    const userIds = [
      ...new Set(rows.flatMap((r) => [r.requesterId, r.proposedId].filter((x): x is string => !!x))),
    ];
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true },
    });
    const nameById = new Map(users.map((u) => [u.id, u.name]));

    return rows.map((r) => ({
      id: r.id,
      status: r.status,
      taskId: r.taskId,
      taskTitle: r.task?.title ?? '(task)',
      projectId: r.projectId,
      projectName: r.project?.name ?? '(project)',
      teamId: r.teamId,
      requesterId: r.requesterId,
      requesterName: nameById.get(r.requesterId) ?? '(user)',
      proposedId: r.proposedId,
      proposedName: r.proposedId ? nameById.get(r.proposedId) ?? '(user)' : null,
      targetType: r.targetType,
      targetId: r.targetId,
      expiresAt: r.expiresAt.toISOString(),
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /**
   * v-next (P3): transition pending requests past their SLA to EXPIRED and
   * notify the requester. Only non-terminal rows with a lapsed expiresAt are
   * touched; best-effort per row so one failure can't stall the sweep. Returns
   * the number expired. `at` is injectable for deterministic tests.
   */
  async sweepExpired(at?: Date): Promise<number> {
    const now = at ?? new Date();
    const due = await prisma.taskAssignmentRequest.findMany({
      where: { status: { in: ['REQUESTED', 'APPROVED', 'FORWARDED'] }, expiresAt: { lte: now } },
      select: { id: true, requesterId: true, teamId: true, taskId: true },
    });
    let expired = 0;
    for (const r of due) {
      try {
        await prisma.taskAssignmentRequest.update({
          where: { id: r.id },
          data: { status: 'EXPIRED', decidedAt: now },
        });
        await notify(r.requesterId, r.teamId, 'ASSIGNMENT_DECIDED', {
          requestId: r.id, taskId: r.taskId, decision: 'expired',
        });
        expired += 1;
      } catch {
        // best-effort per row
      }
    }
    return expired;
  }

  /**
   * v-next (P3): one-shot T-1 reminder. Nudges the approver(s) of pending
   * requests whose SLA lapses within `leadMs`, once each (the remindedAt
   * marker). The forwarded manager is the approver for a FORWARDED request.
   * Returns the number reminded.
   */
  async remindSoon(leadMs: number, at?: Date): Promise<number> {
    const now = at ?? new Date();
    const horizon = new Date(now.getTime() + leadMs);
    const soon = await prisma.taskAssignmentRequest.findMany({
      where: {
        status: { in: ['REQUESTED', 'APPROVED', 'FORWARDED'] },
        remindedAt: null,
        expiresAt: { gt: now, lte: horizon },
      },
      select: {
        id: true, teamId: true, taskId: true, targetType: true, targetId: true,
        status: true, forwardedToId: true,
      },
    });
    let reminded = 0;
    for (const r of soon) {
      try {
        const approvers =
          r.status === 'FORWARDED' && r.forwardedToId
            ? [r.forwardedToId]
            : await this.resolveApprovers(r.targetType, r.targetId);
        for (const uid of approvers) {
          await notify(uid, r.teamId, 'ASSIGNMENT_REQUESTED', {
            requestId: r.id, taskId: r.taskId, reminder: true,
          });
        }
        await prisma.taskAssignmentRequest.update({ where: { id: r.id }, data: { remindedAt: now } });
        reminded += 1;
      } catch {
        // best-effort per row
      }
    }
    return reminded;
  }

  // --- internals ----------------------------------------------------------

  private async load(requestId: string): Promise<TaskAssignmentRequest> {
    const req = await prisma.taskAssignmentRequest.findUnique({ where: { id: requestId } });
    if (!req) throw Errors.notFound('Assignment request not found');
    return req;
  }

  private assertPending(req: TaskAssignmentRequest, allowed: TaskAssignmentRequest['status'][]): void {
    if (!allowed.includes(req.status)) {
      throw Errors.conflict(`Request is ${req.status.toLowerCase()} and can no longer change`);
    }
  }

  /** 404 (not 403) for a non-approver so request existence never leaks. */
  private async assertApprover(req: TaskAssignmentRequest, actorId: string): Promise<void> {
    const approvers = await this.resolveApprovers(req.targetType, req.targetId);
    const isForwardTarget = req.status === 'FORWARDED' && req.forwardedToId === actorId;
    if (!approvers.includes(actorId) && !isForwardTarget) {
      throw Errors.notFound('Assignment request not found');
    }
  }

  private async resolveApprovers(
    targetType: TaskAssignmentRequest['targetType'],
    targetId: string,
  ): Promise<string[]> {
    if (targetType === 'GROUP') {
      const managers = await prisma.userGroupMember.findMany({
        where: { groupId: targetId, role: 'MANAGER', status: 'ACCEPTED' },
        select: { userId: true },
      });
      return managers.map((m) => m.userId);
    }
    return this.teamManagerIds(targetId);
  }

  /** The assignee must belong to the unit (B) or division (C) that approved. */
  private async assertAssigneeWithinTarget(req: TaskAssignmentRequest, assigneeId: string): Promise<void> {
    if (req.targetType === 'GROUP') {
      const inUnit = await prisma.userGroupMember.findFirst({
        where: { groupId: req.targetId, userId: assigneeId, status: 'ACCEPTED' },
        select: { id: true },
      });
      if (!inUnit) throw Errors.badRequest('Assignee is not a member of the approving department');
      return;
    }
    // TEAM: a member of the division — team membership or any unit within it.
    const [teamMember, unitMember] = await Promise.all([
      prisma.teamMembership.findUnique({
        where: { userId_teamId: { userId: assigneeId, teamId: req.targetId } },
        select: { id: true },
      }),
      prisma.userGroupMember.findFirst({
        where: { userId: assigneeId, teamId: req.targetId, isUnit: true, status: 'ACCEPTED' },
        select: { id: true },
      }),
    ]);
    if (!teamMember && !unitMember) throw Errors.badRequest('Assignee is not a member of the approving division');
  }

  private async assertTaskInProjectTeam(
    teamId: string,
    projectId: string,
    taskId: string,
  ): Promise<{ id: string; title: string }> {
    const task = await prisma.task.findFirst({
      where: { id: taskId, projectId, teamId, deletedAt: null },
      select: { id: true, title: true },
    });
    if (!task) throw Errors.notFound('Task not found');
    return task;
  }

  /** Managers of a team = holders of `project.edit` there (manager-tier proxy). */
  private async teamManagerIds(teamId: string): Promise<string[]> {
    const memberships = await prisma.teamMembership.findMany({
      where: { teamId },
      select: { userId: true, roleId: true, role: true },
    });
    const out: string[] = [];
    for (const m of memberships) {
      if (m.roleId) {
        const has = await prisma.rolePermission.findUnique({
          where: { roleId_permission: { roleId: m.roleId, permission: 'project.edit' } },
          select: { roleId: true },
        });
        if (has) out.push(m.userId);
      } else if (m.role === 'MANAGER') {
        out.push(m.userId);
      }
    }
    return out;
  }

  /** Team ids where the actor resolves as a manager (deputy). */
  private async teamsWhereManager(actorId: string): Promise<string[]> {
    const memberships = await prisma.teamMembership.findMany({
      where: { userId: actorId },
      select: { teamId: true, roleId: true, role: true },
    });
    const out: string[] = [];
    for (const m of memberships) {
      if (m.roleId) {
        const has = await prisma.rolePermission.findUnique({
          where: { roleId_permission: { roleId: m.roleId, permission: 'project.edit' } },
          select: { roleId: true },
        });
        if (has) out.push(m.teamId);
      } else if (m.role === 'MANAGER') {
        out.push(m.teamId);
      }
    }
    return out;
  }
}

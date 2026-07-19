import type { GlobalRole, Prisma, ProjectGrantLevel, ProjectGrantSubject } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';
import { loadEnv } from '../config/env.js';
import { userHasPermission } from '../middleware/requirePermission.js';
import { notificationsHub } from './notificationsHub.js';

// v2.8 (Phases 2+3): the unified sharing surface.
//
// One service owns every grant mutation, and one rule makes the whole design
// coherent across all three ACCESS_UNIFIED_GRANTS modes:
//
//   THE LEGACY ROW IS WRITTEN WHEN — AND ONLY WHEN — THE GRANT IS ACTIVE.
//
// During `off`/`dual` the legacy tables are authoritative, so a grant that
// dual-writes its legacy row on creation would take effect before anyone
// consented; one that never dual-writes would silently do nothing and log a
// divergence besides. Tying the legacy write to ACTIVATION means consent gates
// actual access identically in every mode, and dual-mode divergence logs stay
// clean because the two models always agree.
//
// Consent boundaries (Phase 3, register defaults D-5/D-7):
//   TEAM subject        cross-team by definition -> PENDING, accepted by a
//                       manager of the TARGET team (they answer for their
//                       people's attention)
//   GROUP, kind=UNIT    PENDING, accepted by the unit's MANAGER, once per
//                       project per unit (the supervisor commits the unit)
//   GROUP, kind=COLLAB  ACTIVE immediately — consent already lives on the
//                       group MEMBERSHIP (ACCEPTED status), the Phase 2
//                       semantics note; adding grant-level consent on top
//                       would double-ask
//   USER subject        ACTIVE immediately — a personal grant is the digital
//                       twin of being handed work; declining it is a human
//                       conversation, not a workflow state
//   global ADMIN        imposed path — always ACTIVE, notification only
//   ACCESS_GRANT_CONSENT=false  everything ACTIVE (the Phase 3 rollback lever)
//
// Per-task acceptance stays rejected (ARCHITECTURE.md invariant).

export interface GrantView {
  id: string;
  projectId: string;
  subjectType: ProjectGrantSubject;
  subjectId: string;
  subjectName: string;
  level: ProjectGrantLevel;
  status: 'PENDING' | 'ACTIVE' | 'DECLINED';
  source: string | null;
  grantedByName: string | null;
  grantedAt: Date;
  expiresAt: Date | null;
}

export interface PendingApprovalView extends GrantView {
  projectName: string;
  teamName: string;
}

async function subjectName(subjectType: ProjectGrantSubject, subjectId: string): Promise<string> {
  switch (subjectType) {
    case 'USER': {
      const u = await prisma.user.findUnique({ where: { id: subjectId }, select: { name: true } });
      return u?.name ?? '(deleted user)';
    }
    case 'GROUP': {
      const g = await prisma.userGroup.findUnique({ where: { id: subjectId }, select: { name: true } });
      return g?.name ?? '(deleted group)';
    }
    case 'TEAM': {
      const t = await prisma.team.findUnique({ where: { id: subjectId }, select: { name: true } });
      return t?.name ?? '(deleted team)';
    }
    case 'ORG_UNIT':
      return '(org unit — Phase 5)';
  }
}

async function notify(userId: string, teamId: string | null, type: 'GRANT_PENDING' | 'GRANT_DECIDED', payload: Prisma.InputJsonValue): Promise<void> {
  try {
    await prisma.notification.create({
      data: { userId, teamId, type, payload },
    });
    notificationsHub.publish(userId, { type: 'notification:new', id: '' });
  } catch {
    // Notifications are best-effort everywhere in this codebase; a grant must
    // never fail because its announcement did.
  }
}

/** Managers of a team = holders of `project.edit` there (manager-tier proxy). */
async function teamManagerIds(teamId: string): Promise<string[]> {
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

async function toView(g: {
  id: string; projectId: string; subjectType: ProjectGrantSubject; subjectId: string;
  level: ProjectGrantLevel; status: 'PENDING' | 'ACTIVE' | 'DECLINED'; source: string | null;
  grantedAt: Date; expiresAt: Date | null;
  grantedBy: { name: string } | null;
}): Promise<GrantView> {
  return {
    id: g.id,
    projectId: g.projectId,
    subjectType: g.subjectType,
    subjectId: g.subjectId,
    subjectName: await subjectName(g.subjectType, g.subjectId),
    level: g.level,
    status: g.status,
    source: g.source,
    grantedByName: g.grantedBy?.name ?? null,
    grantedAt: g.grantedAt,
    expiresAt: g.expiresAt,
  };
}

const GRANT_INCLUDE = { grantedBy: { select: { name: true } } } as const;

export class ProjectGrantsService {
  private async assertProject(teamId: string, projectId: string) {
    const p = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, name: true, teamId: true, ownerId: true },
    });
    if (!p || p.teamId !== teamId) throw Errors.notFound('Project not found');
    return p;
  }

  /** May the actor share this project at all? Owner, ADMIN, or project.share. */
  private async assertCanShare(
    teamId: string,
    project: { ownerId: string | null },
    actorId: string,
    actorGlobalRole: GlobalRole,
  ): Promise<void> {
    if (actorGlobalRole === 'ADMIN') return;
    if (project.ownerId === actorId) return;
    if (await userHasPermission(actorId, teamId, actorGlobalRole, 'project.share')) return;
    throw Errors.forbidden('Missing permission: project.share');
  }

  async list(teamId: string, projectId: string): Promise<GrantView[]> {
    await this.assertProject(teamId, projectId);
    const rows = await prisma.projectAccessGrant.findMany({
      where: { projectId },
      include: GRANT_INCLUDE,
      orderBy: { grantedAt: 'asc' },
    });
    return Promise.all(rows.map(toView));
  }

  async create(
    teamId: string,
    projectId: string,
    actorId: string,
    actorGlobalRole: GlobalRole,
    input: { subjectType: ProjectGrantSubject; subjectId: string; level: ProjectGrantLevel; expiresAt?: string | null },
  ): Promise<GrantView> {
    const project = await this.assertProject(teamId, projectId);
    await this.assertCanShare(teamId, project, actorId, actorGlobalRole);

    if (input.subjectType === 'ORG_UNIT') {
      throw Errors.badRequest('ORG_UNIT grants arrive in Phase 5');
    }

    // Validate the subject exists and derive the consent boundary.
    let pendingApproverIds: string[] = [];
    let approverTeamId: string | null = null;

    if (input.subjectType === 'USER') {
      const u = await prisma.user.findUnique({ where: { id: input.subjectId }, select: { id: true, disabledAt: true } });
      if (!u || u.disabledAt) throw Errors.badRequest('Grant subject user not found');
    } else if (input.subjectType === 'GROUP') {
      const g = await prisma.userGroup.findUnique({
        where: { id: input.subjectId },
        select: { id: true, teamId: true, kind: true },
      });
      if (!g) throw Errors.badRequest('Grant subject group not found');
      if (g.kind === 'UNIT') {
        // Unit participation: the unit's MANAGER accepts, once per project.
        const managers = await prisma.userGroupMember.findMany({
          where: { groupId: g.id, role: 'MANAGER', status: 'ACCEPTED' },
          select: { userId: true },
        });
        pendingApproverIds = managers.map((m) => m.userId);
        approverTeamId = g.teamId;
      }
    } else {
      // TEAM subject — cross-team by definition. Sharing a project INTO its
      // own home team is meaningless (members already have their access paths).
      const t = await prisma.team.findUnique({ where: { id: input.subjectId }, select: { id: true } });
      if (!t) throw Errors.badRequest('Grant subject team not found');
      if (input.subjectId === teamId) {
        throw Errors.badRequest('A project cannot be shared to its own home team');
      }
      pendingApproverIds = await teamManagerIds(input.subjectId);
      approverTeamId = input.subjectId;
    }

    // Consent decision. ADMIN keeps the imposed path; the flag is the Phase 3
    // rollback lever; a consent boundary with NO approver must not create an
    // unapprovable grant — surface the config problem instead.
    const consentOn = loadEnv().ACCESS_GRANT_CONSENT;
    const needsConsent =
      consentOn && actorGlobalRole !== 'ADMIN' && pendingApproverIds.length > 0;
    if (consentOn && actorGlobalRole !== 'ADMIN' && approverTeamId && pendingApproverIds.length === 0) {
      throw Errors.badRequest(
        input.subjectType === 'TEAM'
          ? 'The target team has no manager to accept this share — designate one first'
          : 'This unit has no manager to accept participation — designate one first',
      );
    }

    const status = needsConsent ? 'PENDING' : 'ACTIVE';

    const grant = await prisma.projectAccessGrant.upsert({
      where: {
        projectId_subjectType_subjectId_level: {
          projectId, subjectType: input.subjectType, subjectId: input.subjectId, level: input.level,
        },
      },
      // Re-granting a DECLINED grant re-asks; re-granting PENDING/ACTIVE is a no-op refresh.
      update: { status, grantedById: actorId, expiresAt: input.expiresAt ? new Date(input.expiresAt) : null },
      create: {
        projectId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        level: input.level,
        status,
        grantedById: actorId,
        source: 'panel',
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      },
      include: GRANT_INCLUDE,
    });

    if (status === 'ACTIVE') {
      await this.writeLegacyRow(projectId, input.subjectType, input.subjectId, input.level);
      // Imposed path / auto-accept: those who WOULD have approved get told.
      for (const uid of pendingApproverIds) {
        await notify(uid, approverTeamId, 'GRANT_DECIDED', {
          grantId: grant.id, projectId, projectName: (await this.assertProject(teamId, projectId)).name,
          decision: 'imposed', level: input.level,
        });
      }
    } else {
      for (const uid of pendingApproverIds) {
        await notify(uid, approverTeamId, 'GRANT_PENDING', {
          grantId: grant.id, projectId, projectName: project.name,
          subjectType: input.subjectType, level: input.level,
        });
      }
    }

    return toView(grant);
  }

  /**
   * Grants awaiting THIS user's approval: TEAM grants where they manage the
   * target team, UNIT grants where they manage the unit. The notifications
   * inbox renders this list.
   */
  async pendingForApprover(userId: string): Promise<PendingApprovalView[]> {
    const [managedTeamIds, managedUnitIds] = await Promise.all([
      // Teams where the user is manager-tier (project.edit — same proxy as
      // teamManagerIds, inverted).
      prisma.teamMembership
        .findMany({ where: { userId }, select: { teamId: true, roleId: true, role: true } })
        .then(async (ms) => {
          const out: string[] = [];
          for (const m of ms) {
            if (m.roleId) {
              const has = await prisma.rolePermission.findUnique({
                where: { roleId_permission: { roleId: m.roleId, permission: 'project.edit' } },
                select: { roleId: true },
              });
              if (has) out.push(m.teamId);
            } else if (m.role === 'MANAGER') out.push(m.teamId);
          }
          return out;
        }),
      prisma.userGroupMember
        .findMany({
          where: { userId, role: 'MANAGER', status: 'ACCEPTED', isUnit: true },
          select: { groupId: true },
        })
        .then((rows) => rows.map((r) => r.groupId)),
    ]);

    const rows = await prisma.projectAccessGrant.findMany({
      where: {
        status: 'PENDING',
        OR: [
          ...(managedTeamIds.length ? [{ subjectType: 'TEAM' as const, subjectId: { in: managedTeamIds } }] : []),
          ...(managedUnitIds.length ? [{ subjectType: 'GROUP' as const, subjectId: { in: managedUnitIds } }] : []),
        ],
      },
      include: {
        ...GRANT_INCLUDE,
        project: { select: { name: true, team: { select: { name: true } } } },
      },
      orderBy: { grantedAt: 'desc' },
    });
    // Zero OR clauses would mean "every pending grant" — return early instead.
    if (!managedTeamIds.length && !managedUnitIds.length) return [];

    return Promise.all(
      rows.map(async (g) => ({
        ...(await toView(g)),
        projectName: g.project.name,
        teamName: g.project.team.name,
      })),
    );
  }

  /** Accept or decline a PENDING grant. Only a legitimate approver may. */
  async decide(
    grantId: string,
    actorId: string,
    actorGlobalRole: GlobalRole,
    decision: 'accept' | 'decline',
  ): Promise<GrantView> {
    const grant = await prisma.projectAccessGrant.findUnique({
      where: { id: grantId },
      include: { ...GRANT_INCLUDE, project: { select: { name: true, teamId: true } } },
    });
    if (!grant) throw Errors.notFound('Grant not found');
    if (grant.status !== 'PENDING') throw Errors.badRequest('Grant is not pending');

    // Authority check mirrors the boundary that made it PENDING.
    let allowed = actorGlobalRole === 'ADMIN';
    if (!allowed && grant.subjectType === 'TEAM') {
      allowed = (await teamManagerIds(grant.subjectId)).includes(actorId);
    }
    if (!allowed && grant.subjectType === 'GROUP') {
      const m = await prisma.userGroupMember.findUnique({
        where: { groupId_userId: { groupId: grant.subjectId, userId: actorId } },
        select: { role: true, status: true },
      });
      allowed = m?.role === 'MANAGER' && m.status === 'ACCEPTED';
    }
    if (!allowed) throw Errors.forbidden('Only the responsible manager can decide this grant');

    const status = decision === 'accept' ? 'ACTIVE' : 'DECLINED';
    const updated = await prisma.projectAccessGrant.update({
      where: { id: grantId },
      data: { status },
      include: GRANT_INCLUDE,
    });

    // THE rule: activation writes the legacy row; a decline writes nothing.
    if (status === 'ACTIVE') {
      await this.writeLegacyRow(grant.projectId, grant.subjectType, grant.subjectId, grant.level);
    }

    if (grant.grantedById) {
      await notify(grant.grantedById, grant.project.teamId, 'GRANT_DECIDED', {
        grantId, projectId: grant.projectId, projectName: grant.project.name,
        decision: status, subjectType: grant.subjectType,
      });
    }

    return toView(updated);
  }

  async revoke(
    teamId: string,
    projectId: string,
    grantId: string,
    actorId: string,
    actorGlobalRole: GlobalRole,
  ): Promise<void> {
    const project = await this.assertProject(teamId, projectId);
    await this.assertCanShare(teamId, project, actorId, actorGlobalRole);
    const grant = await prisma.projectAccessGrant.findUnique({ where: { id: grantId } });
    if (!grant || grant.projectId !== projectId) throw Errors.notFound('Grant not found');

    await prisma.projectAccessGrant.delete({ where: { id: grantId } });
    // Mirror the removal into the legacy row — but ONLY when no other ACTIVE
    // grant still justifies it (a READ and a WRITE grant to the same subject
    // share one legacy row).
    const sibling = await prisma.projectAccessGrant.findFirst({
      where: { projectId, subjectType: grant.subjectType, subjectId: grant.subjectId, status: 'ACTIVE' },
    });
    if (!sibling) {
      await this.removeLegacyRow(projectId, grant.subjectType, grant.subjectId);
    } else {
      // The surviving grant's level decides the legacy row's level.
      await this.writeLegacyRow(projectId, grant.subjectType, grant.subjectId, sibling.level);
    }
  }

  // ------------------------------------------------------------------
  // Legacy dual-writes. These exist for exactly as long as the legacy tables
  // do (dropped in Phase 6); every branch is a straight translation:
  //   TEAM  -> ProjectTeamShare   (WRITE=FULL, READ=READONLY)
  //   GROUP -> ProjectGroupGrant  (levelless — the member's accessLevel rules)
  //   USER  -> nothing            (legacy had no user grants; a USER grant is
  //            real under `on` and inert under off/dual, which the panel
  //            surfaces so nobody is surprised)
  // ------------------------------------------------------------------

  private async writeLegacyRow(
    projectId: string,
    subjectType: ProjectGrantSubject,
    subjectId: string,
    level: ProjectGrantLevel,
  ): Promise<void> {
    if (subjectType === 'TEAM') {
      await prisma.projectTeamShare.upsert({
        where: { projectId_teamId: { projectId, teamId: subjectId } },
        update: { level: level === 'WRITE' ? 'FULL' : 'READONLY' },
        create: { projectId, teamId: subjectId, level: level === 'WRITE' ? 'FULL' : 'READONLY' },
      });
    } else if (subjectType === 'GROUP') {
      await prisma.projectGroupGrant.upsert({
        where: { projectId_groupId: { projectId, groupId: subjectId } },
        update: {},
        create: { projectId, groupId: subjectId },
      });
    }
  }

  private async removeLegacyRow(
    projectId: string,
    subjectType: ProjectGrantSubject,
    subjectId: string,
  ): Promise<void> {
    if (subjectType === 'TEAM') {
      await prisma.projectTeamShare.deleteMany({ where: { projectId, teamId: subjectId } });
    } else if (subjectType === 'GROUP') {
      await prisma.projectGroupGrant.deleteMany({ where: { projectId, groupId: subjectId } });
    }
  }
}

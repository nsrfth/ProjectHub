import { Prisma, type GlobalRole, type ProjectStatus } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';
// v1.39 (BREAKING): project visibility tightened.
// - globalRole === 'ADMIN' → sees and manages every project on the team.
// - everyone else → sees and manages only their own projects
//   (Project.ownerId === userId). Being a team MANAGER no longer grants
//   cross-project rights.
// - Nested routes (tasks/comments/subtasks/...) cascade the same
//   gate via middleware/requireProjectAccess.ts; URL-guessing past a
//   non-owned project gives 404 just like the projects/list filter does.
//
// The v1.23 `project.edit` / `project.delete` / `project.set_accountable`
// permission checks that were here pre-v1.39 are now dead code (a non-owner
// non-admin 404s at the get() gate). The userHasPermission import is gone
// with them.

export interface ProjectView {
  id: string;
  teamId: string;
  // ownerId is null when the owning user has been deleted (FK SetNull).
  // A manager can reassign by transferring the project to a new owner.
  ownerId: string | null;
  // v1.17: RACI "Accountable" person. Same nullability story as ownerId.
  accountableId: string | null;
  accountableName: string | null;
  name: string;
  description: string | null;
  status: ProjectStatus;
  // v1.41: budget fields. Stringified Decimal — preserves precision past
  // Number.MAX_SAFE_INTEGER and matches what Prisma emits when its
  // Decimal type is JSON-stringified. Two decimal places.
  plannedBudget: string | null;
  actualSpent: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// v1.41: normalise an incoming budget value into the shape Prisma's
// Decimal column expects (null | Prisma.Decimal). Accepts numbers,
// numeric strings, and the literal null. The Zod layer has already
// rejected anything malformed by the time we get here — this is just
// the type coercion + sanitisation step.
function normaliseBudget(v: number | string | null | undefined): Prisma.Decimal | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const s = typeof v === 'number' ? String(v) : v.trim();
  if (s.length === 0) return null;
  return new Prisma.Decimal(s);
}

// Shape the Prisma row into a ProjectView. Centralised so list / get / update
// stay consistent and the accountable join lights up in every response.
function toView(
  p: Awaited<ReturnType<typeof prisma.project.findFirstOrThrow>> & {
    accountable?: { name: string } | null;
  },
): ProjectView {
  return {
    id: p.id,
    teamId: p.teamId,
    ownerId: p.ownerId,
    accountableId: p.accountableId ?? null,
    accountableName: p.accountable?.name ?? null,
    name: p.name,
    description: p.description,
    status: p.status,
    // v1.41: Prisma.Decimal → fixed-2-string. toFixed(2) normalises the
    // wire shape (e.g. "1000" → "1000.00") so the SPA can format without
    // probing for a fractional separator.
    plannedBudget: p.plannedBudget === null ? null : p.plannedBudget.toFixed(2),
    actualSpent: p.actualSpent === null ? null : p.actualSpent.toFixed(2),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

// v1.17: Accountable can be set only to a member of the same team. Skip the
// check when clearing (null). Throws 400 with a friendly message otherwise.
async function assertAccountableInTeam(
  teamId: string,
  accountableId: string | null,
): Promise<void> {
  if (accountableId === null) return;
  const membership = await prisma.teamMembership.findUnique({
    where: { userId_teamId: { userId: accountableId, teamId } },
    select: { userId: true },
  });
  if (!membership) {
    throw Errors.badRequest('Accountable user must be a member of this team');
  }
}

export class ProjectsService {
  async create(
    teamId: string,
    ownerId: string,
    input: {
      name: string;
      description?: string;
      accountableId?: string | null;
      // v1.41: optional budget fields. Accept number | string | null.
      plannedBudget?: number | string | null;
      actualSpent?: number | string | null;
    },
  ): Promise<ProjectView> {
    if (input.accountableId !== undefined) {
      await assertAccountableInTeam(teamId, input.accountableId);
    }
    const planned = normaliseBudget(input.plannedBudget);
    const spent = normaliseBudget(input.actualSpent);
    const p = await prisma.project.create({
      data: {
        teamId,
        ownerId,
        accountableId: input.accountableId ?? null,
        name: input.name,
        description: input.description ?? null,
        ...(planned !== undefined && { plannedBudget: planned }),
        ...(spent !== undefined && { actualSpent: spent }),
      },
      include: { accountable: { select: { name: true } } },
    });
    return toView(p);
  }

  // v1.39 (BREAKING): non-ADMIN callers see only projects they own.
  // Global ADMINs (req.user.globalRole === 'ADMIN') bypass the filter and
  // see every project on the team. Team MANAGERs are no longer privileged
  // for visibility — being a MANAGER doesn't grant cross-project rights.
  //
  // Pre-v1.39: any team member saw every project in the team.
  async list(
    teamId: string,
    callerUserId: string,
    callerGlobalRole: GlobalRole,
  ): Promise<ProjectView[]> {
    const isAdmin = callerGlobalRole === 'ADMIN';
    const rows = await prisma.project.findMany({
      where: {
        teamId,
        // ownerId IS NULL projects (owner was deleted) remain invisible to
        // non-admins. Admins can reassign via a future ownership-transfer
        // endpoint or by hand in the DB.
        ...(isAdmin ? {} : { ownerId: callerUserId }),
      },
      orderBy: { createdAt: 'desc' },
      include: { accountable: { select: { name: true } } },
    });
    return rows.map(toView);
  }

  // v1.39 (BREAKING): non-ADMIN callers get 404 on any project they don't
  // own — even if they're in the project's team. The 404 (vs 403) matches
  // the projects/labels precedent: never leak existence of resources the
  // caller can't see.
  //
  // Pre-v1.39: any team member could read any project in the team.
  async get(
    teamId: string,
    projectId: string,
    callerUserId: string,
    callerGlobalRole: GlobalRole,
  ): Promise<ProjectView> {
    const p = await prisma.project.findUnique({
      where: { id: projectId },
      include: { accountable: { select: { name: true } } },
    });
    // Same 404 whether the project doesn't exist or belongs to another team —
    // never leak the existence of resources across tenants.
    if (!p || p.teamId !== teamId) throw Errors.notFound('Project not found');
    // v1.39 visibility gate.
    if (callerGlobalRole !== 'ADMIN' && p.ownerId !== callerUserId) {
      throw Errors.notFound('Project not found');
    }
    return toView(p);
  }

  async update(
    teamId: string,
    projectId: string,
    callerId: string,
    callerGlobalRole: GlobalRole,
    input: {
      name?: string;
      description?: string | null;
      status?: ProjectStatus;
      accountableId?: string | null;
      // v1.41: optional budget fields. undefined = leave; null = clear.
      plannedBudget?: number | string | null;
      actualSpent?: number | string | null;
    },
  ): Promise<ProjectView> {
    // v1.39: get() applies the visibility gate. Non-ADMIN non-owner 404s
    // before we ever touch the data — the pre-v1.39 v1.23 `project.edit` /
    // `project.set_accountable` permission checks are dead code after the
    // gate, removed.
    await this.get(teamId, projectId, callerId, callerGlobalRole);
    if (input.accountableId !== undefined) {
      await assertAccountableInTeam(teamId, input.accountableId);
    }
    const plannedPatch = normaliseBudget(input.plannedBudget);
    const spentPatch = normaliseBudget(input.actualSpent);
    try {
      const updated = await prisma.project.update({
        where: { id: projectId },
        data: {
          ...(input.name !== undefined && { name: input.name }),
          ...(input.description !== undefined && { description: input.description }),
          ...(input.status !== undefined && { status: input.status }),
          ...(input.accountableId !== undefined && { accountableId: input.accountableId }),
          ...(plannedPatch !== undefined && { plannedBudget: plannedPatch }),
          ...(spentPatch !== undefined && { actualSpent: spentPatch }),
        },
        include: { accountable: { select: { name: true } } },
      });
      return toView(updated);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        throw Errors.notFound('Project not found');
      }
      throw err;
    }
  }

  async remove(
    teamId: string,
    projectId: string,
    callerId: string,
    callerGlobalRole: GlobalRole,
  ): Promise<void> {
    // v1.39: same as update() — the get() gate makes the v1.23
    // `project.delete` permission check below dead code, removed.
    await this.get(teamId, projectId, callerId, callerGlobalRole);
    await prisma.project.delete({ where: { id: projectId } });
  }

  // v1.40: cross-team visibility list for the SPA's Projects page. Returns
  // every project the caller can see across ALL teams they belong to (or
  // every project on the instance for global ADMINs). Each row includes
  // the team name/slug so the SPA can render a per-row chip without a
  // second roundtrip. Owner-scoped same as list().
  async listAllVisible(
    callerUserId: string,
    callerGlobalRole: GlobalRole,
  ): Promise<Array<ProjectView & { teamName: string; teamSlug: string }>> {
    const isAdmin = callerGlobalRole === 'ADMIN';
    let teamFilter: { in: string[] } | undefined;
    if (!isAdmin) {
      // Cap the scope to teams the caller actually belongs to, so an
      // owner-orphaned project from a team they left doesn't surface.
      // Admins skip the membership filter (they see the instance).
      const memberships = await prisma.teamMembership.findMany({
        where: { userId: callerUserId },
        select: { teamId: true },
      });
      teamFilter = { in: memberships.map((m) => m.teamId) };
    }
    const rows = await prisma.project.findMany({
      where: {
        ...(teamFilter ? { teamId: teamFilter } : {}),
        ...(isAdmin ? {} : { ownerId: callerUserId }),
      },
      orderBy: { createdAt: 'desc' },
      include: {
        accountable: { select: { name: true } },
        team: { select: { name: true, slug: true } },
      },
    });
    return rows.map((p) => ({
      ...toView(p),
      teamName: p.team.name,
      teamSlug: p.team.slug,
    }));
  }

  // v1.39: helper for nested routes (tasks / labels / comments
  // / subtasks / attachments / dependencies / recurrence) to enforce the
  // same project-visibility rule at the route layer. The
  // `requireProjectAccess` middleware in middleware/requireProjectAccess.ts
  // wraps this helper; service code can also call it directly.
  //
  // Throws 404 (NOT 403) on any failure mode — matches the projects /
  // labels precedent: never leak existence.
  async assertCallerCanAccess(
    teamId: string,
    projectId: string,
    callerUserId: string,
    callerGlobalRole: GlobalRole,
  ): Promise<void> {
    if (callerGlobalRole === 'ADMIN') {
      // Admins still need the project to actually exist in this team.
      const p = await prisma.project.findUnique({
        where: { id: projectId },
        select: { teamId: true },
      });
      if (!p || p.teamId !== teamId) throw Errors.notFound('Project not found');
      return;
    }
    const p = await prisma.project.findUnique({
      where: { id: projectId },
      select: { teamId: true, ownerId: true },
    });
    if (!p || p.teamId !== teamId || p.ownerId !== callerUserId) {
      throw Errors.notFound('Project not found');
    }
  }
}

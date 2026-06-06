import type { GlobalRole } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';
import type { AuditEntry, AuditQuery } from '../schemas/audit.js';

// Audit-log query surface. Authz is applied here rather than at the route
// layer because the rules depend on the relationship between the requester
// and the rows being read: a MANAGER can read their own team's audit log
// but no one else's, while an ADMIN reads anything.

export interface AuditPage {
  items: AuditEntry[];
  nextCursor: string | null;
}

export class AuditService {
  // Authorize + execute. requester is the calling user (from JWT). Returns a
  // paginated slice — items + nextCursor (null when exhausted).
  async list(
    requester: { sub: string; globalRole: GlobalRole },
    query: AuditQuery,
  ): Promise<AuditPage> {
    const isAdmin = requester.globalRole === 'ADMIN';

    // ── Authz: clamp the team scope to what the requester may see. ─────
    let teamFilter: string | { in: string[] } | undefined;
    if (isAdmin) {
      // No clamp. teamId filter (if any) flows straight through.
      teamFilter = query.teamId;
    } else {
      // Non-admins must be a MANAGER of at least one team. Compute their
      // manager-eligible team set; require any teamId query param to be a
      // subset of it.
      const memberships = await prisma.teamMembership.findMany({
        where: { userId: requester.sub, role: 'MANAGER' },
        select: { teamId: true },
      });
      const managed = memberships.map((m) => m.teamId);
      if (managed.length === 0) {
        throw Errors.forbidden('Audit log requires ADMIN or team MANAGER');
      }
      if (query.teamId) {
        if (!managed.includes(query.teamId)) {
          throw Errors.forbidden('Not a manager of the requested team');
        }
        teamFilter = query.teamId;
      } else {
        teamFilter = { in: managed };
      }
    }

    // ── Build the WHERE clause. ────────────────────────────────────────
    const where: Record<string, unknown> = {};
    if (teamFilter !== undefined) where.teamId = teamFilter;
    if (query.actorId) where.actorId = query.actorId;
    if (query.action) where.action = { contains: query.action };
    if (query.since || query.until) {
      where.createdAt = {
        ...(query.since ? { gte: new Date(query.since) } : {}),
        ...(query.until ? { lte: new Date(query.until) } : {}),
      };
    }

    // ── Cursor pagination. Fetch limit+1 to detect "more". ─────────────
    const rows = await prisma.activity.findMany({
      where: where as never,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      include: {
        actor: { select: { id: true, name: true } },
        task: { select: { id: true, title: true } },
        team: { select: { id: true, name: true } },
      },
    });

    const hasMore = rows.length > query.limit;
    const sliced = hasMore ? rows.slice(0, query.limit) : rows;

    return {
      items: sliced.map((r) => ({
        id: r.id,
        action: r.action,
        actorId: r.actorId,
        actorName: r.actor?.name ?? null,
        taskId: r.taskId,
        taskTitle: r.task?.title ?? null,
        teamId: r.teamId,
        teamName: r.team?.name ?? null,
        meta: r.meta as unknown,
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor: hasMore ? sliced[sliced.length - 1]!.id : null,
    };
  }
}

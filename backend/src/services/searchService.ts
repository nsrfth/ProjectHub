import { Prisma, type TaskStatus } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import type { SearchQuery } from '../schemas/search.js';

// v1.30: full-text search across Task / Comment / Project. Tenant isolation
// is the headline rule: results are restricted to teams the caller is a
// member of. No global-ADMIN bypass — search reflects "what I have access
// to", not "what exists on this instance". An admin who needs the latter
// uses the audit log.
//
// Each bucket is a separate parameterised raw query against its entity's
// pre-computed `searchVector` (GIN-indexed, `simple` config). Pagination
// is per-bucket keyset on (rank, id):
//
//   WHERE  ts_rank(search_vector, q) < $cursor_rank
//      OR (ts_rank(search_vector, q) = $cursor_rank AND id < $cursor_id)
//
// We use plainto_tsquery so the caller can pass arbitrary text — including
// punctuation — without worrying about operator syntax. Empty `q` short-
// circuits to empty buckets (no DB hit).

export interface TaskHit {
  type: 'task';
  id: string;
  title: string;
  status: TaskStatus;
  projectId: string;
  projectName: string;
  teamId: string;
  teamName: string;
  excerpt: string | null;
  rank: number;
}

export interface CommentHit {
  type: 'comment';
  id: string;
  taskId: string;
  taskTitle: string;
  projectId: string;
  projectName: string;
  teamId: string;
  teamName: string;
  excerpt: string;
  authorId: string | null;
  authorName: string | null;
  createdAt: string;
  rank: number;
}

export interface ProjectHit {
  type: 'project';
  id: string;
  name: string;
  teamId: string;
  teamName: string;
  excerpt: string | null;
  rank: number;
}

export interface Bucket<T> {
  items: T[];
  nextCursor: string | null;
}

export interface SearchResults {
  tasks: Bucket<TaskHit>;
  comments: Bucket<CommentHit>;
  projects: Bucket<ProjectHit>;
}

// ts_headline option string — same shape across all three buckets so
// excerpts read consistently in the UI. <b>/</b> are the only HTML the
// frontend's sanitiser allows through.
const HEADLINE_OPTS = 'StartSel=<b>,StopSel=</b>,MaxFragments=2,MaxWords=20,MinWords=5,ShortWord=2';

// Default rank → ts_rank, NOT ts_rank_cd. ts_rank weighs setweight'ed
// vectors against the configured weight vector (default {0.1, 0.2, 0.4, 1.0}
// for D/C/B/A) — that's what gives our 'A'-weighted title matches their
// boost over 'B'-weighted descriptions. cd is for "cover density" and
// doesn't honour setweight the same way.

const EMPTY: SearchResults = {
  tasks: { items: [], nextCursor: null },
  comments: { items: [], nextCursor: null },
  projects: { items: [], nextCursor: null },
};

interface Cursor {
  rank: number;
  id: string;
}

function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  // Format: "<rank>:<id>". Anything else → treat as a fresh query (don't
  // 400 a paginating client because of a copy-paste typo).
  const idx = raw.indexOf(':');
  if (idx <= 0) return null;
  const rank = Number(raw.slice(0, idx));
  const id = raw.slice(idx + 1);
  if (!Number.isFinite(rank) || id.length === 0) return null;
  return { rank, id };
}

function encodeCursor(c: Cursor): string {
  return `${c.rank}:${c.id}`;
}

// Build the keyset predicate for cursor pagination. The rank expression is
// reused exactly as it appears in ORDER BY — Postgres can then index-aware
// optimise the WHERE.
function cursorClause(
  rankExpr: Prisma.Sql,
  idExpr: Prisma.Sql,
  cursor: Cursor | null,
): Prisma.Sql {
  if (!cursor) return Prisma.empty;
  // ts_rank returns `real` (float4). Prisma binds JS numbers as `double
  // precision`, which compares against real via implicit cast. That cast
  // happens at full double precision — meaning the equality arm of the
  // keyset predicate misses when the encoded cursor lost float4 precision
  // on the way out. Cast both bind sides to `real` so the comparison runs
  // at matching precision and the `(rank=cursor.rank AND id<cursor.id)`
  // tiebreak fires correctly when many rows share the same rank.
  return Prisma.sql`AND (
    ${rankExpr} < ${cursor.rank}::real
    OR (${rankExpr} = ${cursor.rank}::real AND ${idExpr} < ${cursor.id})
  )`;
}

export class SearchService {
  // Compute the set of teamIds the caller may search across. Mirrors the
  // pattern from auditService.list — every team membership counts (no
  // role gate); the route already requires authentication.
  private async allowedTeams(userId: string): Promise<string[]> {
    const memberships = await prisma.teamMembership.findMany({
      where: { userId },
      select: { teamId: true },
    });
    return memberships.map((m) => m.teamId);
  }

  async search(userId: string, query: SearchQuery): Promise<SearchResults> {
    const q = query.q.trim();
    if (!q) return EMPTY;

    const allowed = await this.allowedTeams(userId);
    if (allowed.length === 0) return EMPTY;

    // Run only the buckets the caller asked for (or all three when no
    // `type` filter is set). Buckets the caller didn't ask for still
    // appear in the response with empty items — the response shape is
    // stable for the frontend.
    const wantTask = !query.type || query.type === 'task';
    const wantComment = !query.type || query.type === 'comment';
    const wantProject = !query.type || query.type === 'project';

    const [tasks, comments, projects] = await Promise.all([
      wantTask
        ? this.searchTasks(q, allowed, query.limit, decodeCursor(query.taskCursor))
        : Promise.resolve(EMPTY.tasks),
      wantComment
        ? this.searchComments(q, allowed, query.limit, decodeCursor(query.commentCursor))
        : Promise.resolve(EMPTY.comments),
      wantProject
        ? this.searchProjects(q, allowed, query.limit, decodeCursor(query.projectCursor))
        : Promise.resolve(EMPTY.projects),
    ]);

    return { tasks, comments, projects };
  }

  private async searchTasks(
    q: string,
    allowed: string[],
    limit: number,
    cursor: Cursor | null,
  ): Promise<Bucket<TaskHit>> {
    type Row = {
      id: string;
      title: string;
      status: TaskStatus;
      projectId: string;
      projectName: string;
      teamId: string;
      teamName: string;
      excerpt: string | null;
      rank: number;
    };

    // The rank expression appears verbatim in both SELECT and ORDER BY (and
    // again inside the cursor predicate) so Postgres can collapse to a
    // single computation. plainto_tsquery is a stable function over a
    // literal config, so it's hoisted automatically.
    const rankExpr = Prisma.sql`ts_rank(t."searchVector", plainto_tsquery('simple', ${q}))`;
    const idExpr = Prisma.sql`t."id"`;
    const cursorSql = cursorClause(rankExpr, idExpr, cursor);

    const rows = await prisma.$queryRaw<Row[]>`
      SELECT t."id" AS "id",
             t."title" AS "title",
             t."status" AS "status",
             t."projectId" AS "projectId",
             p."name" AS "projectName",
             t."teamId" AS "teamId",
             tm."name" AS "teamName",
             ${rankExpr} AS "rank",
             CASE WHEN t."description" IS NULL OR length(t."description") = 0
                  THEN NULL
                  ELSE ts_headline('simple', t."description",
                                   plainto_tsquery('simple', ${q}),
                                   ${HEADLINE_OPTS})
             END AS "excerpt"
        FROM "Task" t
        JOIN "Project" p ON p."id" = t."projectId"
        JOIN "Team" tm   ON tm."id" = t."teamId"
       WHERE t."searchVector" @@ plainto_tsquery('simple', ${q})
         AND t."deletedAt" IS NULL
         AND t."teamId" = ANY(${allowed}::text[])
         ${cursorSql}
       ORDER BY ${rankExpr} DESC, t."id" DESC
       LIMIT ${limit + 1}
    `;

    const hasMore = rows.length > limit;
    const sliced = hasMore ? rows.slice(0, limit) : rows;
    const last = sliced[sliced.length - 1];
    return {
      items: sliced.map((r) => ({
        type: 'task' as const,
        id: r.id,
        title: r.title,
        status: r.status,
        projectId: r.projectId,
        projectName: r.projectName,
        teamId: r.teamId,
        teamName: r.teamName,
        excerpt: r.excerpt,
        // Postgres `real` arrives as a JS number; coerce defensively in
        // case the driver hands back a Decimal.
        rank: Number(r.rank),
      })),
      nextCursor: hasMore && last ? encodeCursor({ rank: Number(last.rank), id: last.id }) : null,
    };
  }

  private async searchComments(
    q: string,
    allowed: string[],
    limit: number,
    cursor: Cursor | null,
  ): Promise<Bucket<CommentHit>> {
    type Row = {
      id: string;
      taskId: string;
      taskTitle: string;
      projectId: string;
      projectName: string;
      teamId: string;
      teamName: string;
      excerpt: string;
      authorId: string | null;
      authorName: string | null;
      createdAt: Date;
      rank: number;
    };

    // Comments tenant-scope via Task — they don't carry a denormalised
    // teamId. The JOIN to Task also lets us surface the task title (the UI
    // wants to render "Comment on <task title>" without a follow-up call).
    const rankExpr = Prisma.sql`ts_rank(c."searchVector", plainto_tsquery('simple', ${q}))`;
    const idExpr = Prisma.sql`c."id"`;
    const cursorSql = cursorClause(rankExpr, idExpr, cursor);

    const rows = await prisma.$queryRaw<Row[]>`
      SELECT c."id" AS "id",
             c."taskId" AS "taskId",
             t."title" AS "taskTitle",
             t."projectId" AS "projectId",
             p."name" AS "projectName",
             t."teamId" AS "teamId",
             tm."name" AS "teamName",
             ts_headline('simple', c."body",
                         plainto_tsquery('simple', ${q}),
                         ${HEADLINE_OPTS}) AS "excerpt",
             c."authorId" AS "authorId",
             u."name" AS "authorName",
             c."createdAt" AS "createdAt",
             ${rankExpr} AS "rank"
        FROM "Comment" c
        JOIN "Task" t    ON t."id" = c."taskId"
        JOIN "Project" p ON p."id" = t."projectId"
        JOIN "Team" tm   ON tm."id" = t."teamId"
        LEFT JOIN "User" u ON u."id" = c."authorId"
       WHERE c."searchVector" @@ plainto_tsquery('simple', ${q})
         AND c."deletedAt" IS NULL
         AND t."deletedAt" IS NULL
         AND t."teamId" = ANY(${allowed}::text[])
         ${cursorSql}
       ORDER BY ${rankExpr} DESC, c."id" DESC
       LIMIT ${limit + 1}
    `;

    const hasMore = rows.length > limit;
    const sliced = hasMore ? rows.slice(0, limit) : rows;
    const last = sliced[sliced.length - 1];
    return {
      items: sliced.map((r) => ({
        type: 'comment' as const,
        id: r.id,
        taskId: r.taskId,
        taskTitle: r.taskTitle,
        projectId: r.projectId,
        projectName: r.projectName,
        teamId: r.teamId,
        teamName: r.teamName,
        excerpt: r.excerpt,
        authorId: r.authorId,
        authorName: r.authorName,
        createdAt: r.createdAt.toISOString(),
        rank: Number(r.rank),
      })),
      nextCursor: hasMore && last ? encodeCursor({ rank: Number(last.rank), id: last.id }) : null,
    };
  }

  private async searchProjects(
    q: string,
    allowed: string[],
    limit: number,
    cursor: Cursor | null,
  ): Promise<Bucket<ProjectHit>> {
    type Row = {
      id: string;
      name: string;
      teamId: string;
      teamName: string;
      excerpt: string | null;
      rank: number;
    };

    // Projects have no soft-delete column (v1.21 trash was scoped to
    // Task + Comment) — they cascade on team delete.
    const rankExpr = Prisma.sql`ts_rank(p."searchVector", plainto_tsquery('simple', ${q}))`;
    const idExpr = Prisma.sql`p."id"`;
    const cursorSql = cursorClause(rankExpr, idExpr, cursor);

    const rows = await prisma.$queryRaw<Row[]>`
      SELECT p."id" AS "id",
             p."name" AS "name",
             p."teamId" AS "teamId",
             tm."name" AS "teamName",
             CASE WHEN p."description" IS NULL OR length(p."description") = 0
                  THEN NULL
                  ELSE ts_headline('simple', p."description",
                                   plainto_tsquery('simple', ${q}),
                                   ${HEADLINE_OPTS})
             END AS "excerpt",
             ${rankExpr} AS "rank"
        FROM "Project" p
        JOIN "Team" tm ON tm."id" = p."teamId"
       WHERE p."searchVector" @@ plainto_tsquery('simple', ${q})
         AND p."teamId" = ANY(${allowed}::text[])
         ${cursorSql}
       ORDER BY ${rankExpr} DESC, p."id" DESC
       LIMIT ${limit + 1}
    `;

    const hasMore = rows.length > limit;
    const sliced = hasMore ? rows.slice(0, limit) : rows;
    const last = sliced[sliced.length - 1];
    return {
      items: sliced.map((r) => ({
        type: 'project' as const,
        id: r.id,
        name: r.name,
        teamId: r.teamId,
        teamName: r.teamName,
        excerpt: r.excerpt,
        rank: Number(r.rank),
      })),
      nextCursor: hasMore && last ? encodeCursor({ rank: Number(last.rank), id: last.id }) : null,
    };
  }
}

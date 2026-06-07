import { Prisma } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';

// v1.34: per-project bucket grouping.
//
// Cross-team scoping: every lookup carries `teamId` so a bucket whose
// project lives in another team returns 404 (never 403) — matches the
// projB / teamA precedent in projects.test.ts.
//
// `order` is a sort key, NOT a unique constraint. Reorder uses a
// two-phase write inside one transaction:
//   1. Bump every bucket in the project to order = order + 1_000_000
//      (collision-free temporary range).
//   2. Write final 0..n-1 values in the requested order.
// Avoids any intermediate state where two rows share an order value
// within a project. Matches Task.position precedent.

const REORDER_BUMP = 1_000_000;

export interface BucketView {
  id: string;
  projectId: string;
  name: string;
  order: number;
  createdAt: Date;
  updatedAt: Date;
}

function toView(b: {
  id: string;
  projectId: string;
  name: string;
  order: number;
  createdAt: Date;
  updatedAt: Date;
}): BucketView {
  return {
    id: b.id,
    projectId: b.projectId,
    name: b.name,
    order: b.order,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
  };
}

export class BucketsService {
  async list(teamId: string, projectId: string): Promise<BucketView[]> {
    // The project itself must belong to this team — otherwise a cross-tenant
    // probe could list another team's buckets via an unrelated team's URL.
    await this.assertProjectInTeam(teamId, projectId);
    const rows = await prisma.bucket.findMany({
      where: { projectId, teamId },
      orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map(toView);
  }

  async create(
    teamId: string,
    projectId: string,
    input: { name: string },
  ): Promise<BucketView> {
    await this.assertProjectInTeam(teamId, projectId);
    // Append at the end. Reads the current max(order) inside the same
    // transaction as the insert so concurrent creates don't collide on
    // the same value (still not a uniqueness violation because order is
    // non-unique, but keeping the sequence monotonic is friendlier).
    const created = await prisma.$transaction(async (tx) => {
      const tail = await tx.bucket.findFirst({
        where: { projectId },
        orderBy: { order: 'desc' },
        select: { order: true },
      });
      const nextOrder = (tail?.order ?? -1) + 1;
      return tx.bucket.create({
        data: {
          projectId,
          teamId,
          name: input.name,
          order: nextOrder,
        },
      });
    });
    return toView(created);
  }

  async update(
    teamId: string,
    bucketId: string,
    input: { name?: string },
  ): Promise<BucketView> {
    await this.assertBucketInTeam(teamId, bucketId);
    try {
      const updated = await prisma.bucket.update({
        where: { id: bucketId },
        data: {
          ...(input.name !== undefined && { name: input.name }),
        },
      });
      return toView(updated);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        throw Errors.notFound('Bucket not found');
      }
      throw err;
    }
  }

  async remove(teamId: string, bucketId: string): Promise<void> {
    await this.assertBucketInTeam(teamId, bucketId);
    try {
      // Tasks in this bucket get bucketId set to NULL by the FK ON DELETE
      // SET NULL — they survive in the project, unbucketed.
      await prisma.bucket.delete({ where: { id: bucketId } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        throw Errors.notFound('Bucket not found');
      }
      throw err;
    }
  }

  // Full-permutation reorder. Strict mode: bucketIds must be exactly the set
  // of buckets currently in the project (same length, no duplicates, no
  // foreign ids, no missing ids). Otherwise 400 BUCKET_REORDER_MISMATCH.
  async reorder(
    teamId: string,
    projectId: string,
    input: { bucketIds: string[] },
  ): Promise<BucketView[]> {
    await this.assertProjectInTeam(teamId, projectId);

    const ids = input.bucketIds;
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) {
        throw Errors.badRequest(
          'Reorder list contains a duplicate bucket id',
          { reason: 'BUCKET_REORDER_MISMATCH', duplicate: id },
        );
      }
      seen.add(id);
    }

    const result = await prisma.$transaction(async (tx) => {
      const current = await tx.bucket.findMany({
        where: { projectId },
        select: { id: true },
      });
      const currentIds = new Set(current.map((b) => b.id));

      if (current.length !== ids.length) {
        throw Errors.badRequest(
          `Reorder list must contain every bucket in the project (got ${ids.length}, expected ${current.length})`,
          { reason: 'BUCKET_REORDER_MISMATCH', got: ids.length, expected: current.length },
        );
      }
      for (const id of ids) {
        if (!currentIds.has(id)) {
          throw Errors.badRequest(
            `Bucket ${id} is not in this project`,
            { reason: 'BUCKET_REORDER_MISMATCH', strayId: id },
          );
        }
      }

      // Phase 1: bump everyone into the collision-free range. This keeps
      // any concurrent reads stable-ish (still sorted, just offset).
      await tx.bucket.updateMany({
        where: { projectId },
        data: { order: { increment: REORDER_BUMP } },
      });

      // Phase 2: settle to 0..n-1 in the requested order. updatedAt fires
      // on each row.
      for (let i = 0; i < ids.length; i++) {
        await tx.bucket.update({
          where: { id: ids[i]! },
          data: { order: i },
        });
      }

      return tx.bucket.findMany({
        where: { projectId, teamId },
        orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
      });
    });
    return result.map(toView);
  }

  // ── helpers ────────────────────────────────────────────────────────────

  // 404 if the project doesn't exist OR belongs to another team. Same
  // shape as the projects/labels precedent — never leak existence.
  private async assertProjectInTeam(teamId: string, projectId: string): Promise<void> {
    const proj = await prisma.project.findUnique({
      where: { id: projectId },
      select: { teamId: true },
    });
    if (!proj || proj.teamId !== teamId) {
      throw Errors.notFound('Project not found');
    }
  }

  // 404 if the bucket doesn't exist OR its project's team doesn't match.
  private async assertBucketInTeam(teamId: string, bucketId: string): Promise<void> {
    const b = await prisma.bucket.findUnique({
      where: { id: bucketId },
      select: { teamId: true },
    });
    if (!b || b.teamId !== teamId) {
      throw Errors.notFound('Bucket not found');
    }
  }

  // Used by tasksService to validate cross-bucket moves. Returns the bucket
  // row when it exists in (teamId, projectId), null otherwise. The CALLER
  // is responsible for turning null into the right error (400 cross-project
  // vs 404 cross-team).
  async findInProject(
    teamId: string,
    projectId: string,
    bucketId: string,
  ): Promise<{ id: string; projectId: string; teamId: string } | null> {
    const b = await prisma.bucket.findUnique({
      where: { id: bucketId },
      select: { id: true, projectId: true, teamId: true },
    });
    if (!b) return null;
    if (b.teamId !== teamId) return null; // 404 — cross-tenant
    if (b.projectId !== projectId) return b; // caller decides (400)
    return b;
  }
}

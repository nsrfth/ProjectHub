import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { BucketsService } from '../services/bucketsService.js';
import { BucketsController } from '../controllers/bucketsController.js';
import { requireAuth, requireTeamRole } from '../middleware/auth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import {
  requireBucketProjectAccess,
  requireProjectAccess,
} from '../middleware/requireProjectAccess.js';
import { requireScope } from '../middleware/requireScope.js';
import {
  bucketListResponse,
  bucketResponse,
  createBucketBody,
  reorderBucketsBody,
  reorderBucketsResponse,
  updateBucketBody,
} from '../schemas/buckets.js';

// v1.34: per-project bucket grouping. Two route files mounted at different
// prefixes — keeps the URLs self-describing without writing a custom
// "resolve team from bucket id" middleware.
//
//   projectBucketsRoutes  → /teams/:teamId/projects/:projectId/buckets
//     GET  /              list
//     POST /              create
//     PATCH /reorder      bulk reorder (full permutation)
//
//   bucketByIdRoutes      → /teams/:teamId/buckets
//     PATCH /:bucketId    rename
//     DELETE /:bucketId   remove (tasks fall back to bucketId: null)
//
// All routes share requireAuth + requireTeamRole. Writes also require the
// `buckets.manage` permission (default-granted to MANAGER + MEMBER). Reads
// are implicit team-member capability.

export async function projectBucketsRoutes(app: FastifyInstance): Promise<void> {
  const svc = new BucketsService();
  const ctrl = new BucketsController(svc);
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireTeamRole('MEMBER', 'MANAGER'));
  // v1.39: project visibility cascade. Only applies here (project-nested);
  // bucketByIdRoutes below has no projectId in its URL.
  r.addHook('preHandler', requireProjectAccess());

  r.get('/', {
    preHandler: requireScope('projects:read'),
    schema: {
      tags: ['buckets'],
      summary: 'List buckets for a project, ordered by `order` asc',
      params: z.object({ teamId: z.string(), projectId: z.string() }),
      response: { 200: bucketListResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.list,
  });

  r.post('/', {
    preHandler: [requireScope('projects:write'), requirePermission('buckets.manage')],
    schema: {
      tags: ['buckets'],
      summary: 'Create a bucket. Server assigns `order` = max(order)+1 within the project.',
      params: z.object({ teamId: z.string(), projectId: z.string() }),
      body: createBucketBody,
      response: { 201: bucketResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.create,
  });

  r.patch('/reorder', {
    preHandler: [requireScope('projects:write'), requirePermission('buckets.manage')],
    schema: {
      tags: ['buckets'],
      summary:
        'Reorder buckets within a project. Body must be a FULL permutation of every bucketId in the project (strict mode).',
      params: z.object({ teamId: z.string(), projectId: z.string() }),
      body: reorderBucketsBody,
      response: { 200: reorderBucketsResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.reorder,
  });
}

export async function bucketByIdRoutes(app: FastifyInstance): Promise<void> {
  const svc = new BucketsService();
  const ctrl = new BucketsController(svc);
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireTeamRole('MEMBER', 'MANAGER'));
  // v1.39: bucket-by-id routes look up project ownership via the bucket's
  // own projectId. Without this, a non-owner could PATCH/DELETE buckets
  // in a project they can't see in the projects list.
  r.addHook('preHandler', requireBucketProjectAccess());

  r.patch('/:bucketId', {
    preHandler: [requireScope('projects:write'), requirePermission('buckets.manage')],
    schema: {
      tags: ['buckets'],
      summary: 'Rename a bucket.',
      params: z.object({ teamId: z.string(), bucketId: z.string() }),
      body: updateBucketBody,
      response: { 200: bucketResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.update,
  });

  r.delete('/:bucketId', {
    preHandler: [requireScope('projects:write'), requirePermission('buckets.manage')],
    schema: {
      tags: ['buckets'],
      summary:
        'Delete a bucket. Tasks in the bucket have bucketId set to null (FK ON DELETE SET NULL); they survive in the project, unbucketed.',
      params: z.object({ teamId: z.string(), bucketId: z.string() }),
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.remove,
  });
}

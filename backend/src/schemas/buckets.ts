import { z } from 'zod';

// v1.34: per-project bucket grouping. Lightweight columns independent of
// task status. Tasks carry an optional bucketId; the bucket itself is
// project-scoped + (denormalized) team-scoped for the multi-tenant filter.

export const createBucketBody = z.object({
  name: z.string().min(1).max(80).trim(),
});

export const updateBucketBody = z
  .object({
    name: z.string().min(1).max(80).trim().optional(),
  })
  .refine((v) => v.name !== undefined, 'Provide at least one field to update');

// Full-permutation reorder. The client sends every bucketId that belongs to
// the project, in the desired order. Partial reorders are deliberately
// rejected — they invite race conditions when two clients reorder
// concurrently. Drag-and-drop UIs naturally send full permutations.
export const reorderBucketsBody = z.object({
  bucketIds: z
    .array(z.string().min(1))
    .min(1)
    .max(200),
});

export const bucketResponse = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  order: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const bucketListResponse = z.array(bucketResponse);

export const reorderBucketsResponse = z.object({
  items: bucketListResponse,
});

export type CreateBucketBody = z.infer<typeof createBucketBody>;
export type UpdateBucketBody = z.infer<typeof updateBucketBody>;
export type ReorderBucketsBody = z.infer<typeof reorderBucketsBody>;

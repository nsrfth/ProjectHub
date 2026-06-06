import { z } from 'zod';

export const createCommentBody = z.object({
  body: z.string().min(1).max(10_000).trim(),
});

export const updateCommentBody = z.object({
  body: z.string().min(1).max(10_000).trim(),
});

export const commentResponse = z.object({
  id: z.string(),
  taskId: z.string(),
  // Nullable once the author user has been deleted (FK SetNull).
  authorId: z.string().nullable(),
  authorName: z.string().nullable(),
  body: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type CreateCommentBody = z.infer<typeof createCommentBody>;
export type UpdateCommentBody = z.infer<typeof updateCommentBody>;

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
  authorId: z.string(),
  authorName: z.string(),
  body: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type CreateCommentBody = z.infer<typeof createCommentBody>;
export type UpdateCommentBody = z.infer<typeof updateCommentBody>;

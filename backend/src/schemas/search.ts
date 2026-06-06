import { z } from 'zod';
import { taskStatusEnum } from './tasks.js';

// v1.30: shapes for /api/search. Per-type buckets, each with its own cursor.

export const searchTypeEnum = z.enum(['task', 'comment', 'project']);

export const searchQuery = z.object({
  // Caller-supplied query string. plainto_tsquery handles whitespace,
  // punctuation, and operator-like input safely — no need to sanitise here.
  q: z.string().max(200).default(''),
  // Optional bucket filter. When set, only that bucket's items are filled;
  // the other two buckets return empty `items` arrays for shape stability.
  type: searchTypeEnum.optional(),
  // Per-bucket cursors. Format: `<rank>:<id>` where rank is the ts_rank
  // float of the last row in the previous page. Opaque to the client.
  taskCursor: z.string().optional(),
  commentCursor: z.string().optional(),
  projectCursor: z.string().optional(),
  // Per-bucket page size. Cap at 50 — search isn't a deep-paginated surface,
  // and ts_rank-ordered scans get pricier the further you go.
  limit: z.coerce.number().int().positive().max(50).default(20),
});

export type SearchQuery = z.infer<typeof searchQuery>;

const baseHit = {
  // Cursor token for THIS row — convenient if the client wants to "Load more"
  // by clicking a specific row. Today nextCursor is the only one consumed.
  rank: z.number(),
};

export const taskHit = z.object({
  type: z.literal('task'),
  id: z.string(),
  title: z.string(),
  status: taskStatusEnum,
  projectId: z.string(),
  projectName: z.string(),
  teamId: z.string(),
  teamName: z.string(),
  // ts_headline-rendered excerpt of the description. May be null when the
  // match was only in the title (or there's no description). HTML containing
  // only <b>...</b> highlights — the frontend strips everything else.
  excerpt: z.string().nullable(),
  ...baseHit,
});

export const commentHit = z.object({
  type: z.literal('comment'),
  id: z.string(),
  taskId: z.string(),
  taskTitle: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  teamId: z.string(),
  teamName: z.string(),
  excerpt: z.string(),
  authorId: z.string().nullable(),
  authorName: z.string().nullable(),
  createdAt: z.string(),
  ...baseHit,
});

export const projectHit = z.object({
  type: z.literal('project'),
  id: z.string(),
  name: z.string(),
  teamId: z.string(),
  teamName: z.string(),
  excerpt: z.string().nullable(),
  ...baseHit,
});

const bucket = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });

export const searchResults = z.object({
  tasks: bucket(taskHit),
  comments: bucket(commentHit),
  projects: bucket(projectHit),
});

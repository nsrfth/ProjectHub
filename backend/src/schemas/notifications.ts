import { z } from 'zod';

export const notifyTypeEnum = z.enum([
  'TASK_ASSIGNED',
  'TASK_COMMENT',
  'TASK_DUE',
  'MENTION',
  'TASK_STATUS',
]);

export const listNotificationsQuery = z.object({
  unreadOnly: z
    .string()
    .optional()
    .transform((v) => v === 'true')
    .pipe(z.boolean().optional()),
  limit: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : undefined))
    .pipe(z.number().int().positive().max(100).optional()),
});

export const notificationResponse = z.object({
  id: z.string(),
  userId: z.string(),
  teamId: z.string(),
  type: notifyTypeEnum,
  // Payload shape varies per type; the frontend switches on `type` and reads
  // expected fields. Keep it loose at the API boundary.
  payload: z.unknown(),
  readAt: z.string().nullable(),
  createdAt: z.string(),
});

export const unreadCountResponse = z.object({
  count: z.number().int().nonnegative(),
});

export type ListNotificationsQuery = z.infer<typeof listNotificationsQuery>;

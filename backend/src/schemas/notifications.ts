import { z } from 'zod';

export const notifyTypeEnum = z.enum([
  'TASK_ASSIGNED',
  'TASK_COMMENT',
  'TASK_DUE',
  'MENTION',
  'TASK_STATUS',
  // v1.87.1: these are emitted by the services (group invites, dependency
  // unblocks) and exist in the DB, but were missing here — so the response
  // serializer (z.array(notificationResponse)) threw a ResponseValidationError
  // and the whole /api/notifications feed 500'd for any user holding one.
  'GROUP_INVITE',
  'TASK_UNBLOCKED',
  // v2.5.28: both were emitted by services + stored in the DB but missing from
  // this serializer enum — a held notification of either type would 500 the
  // whole /api/notifications feed (same class of bug as the v1.87.1 note above).
  'CORRESPONDENCE_REFERRAL',
  'STANDALONE_TASK_DUE',
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
  // v2.5.28: nullable — personal (standalone) task notifications carry no team.
  teamId: z.string().nullable(),
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

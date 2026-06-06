import { z } from 'zod';

// Audit-log filter query. All filters are optional; combine freely.
// `since` / `until` are ISO timestamps. Pagination is cursor-based (using
// the row id of the last item from the previous page) so the data layer can
// keep using the (createdAt) indexes without an offset scan.
export const auditQuery = z.object({
  // Team scope. ADMIN may omit (returns instance-wide); MANAGER must
  // include one of their team ids; MEMBER is rejected at the route layer.
  teamId: z.string().optional(),
  actorId: z.string().optional(),
  // Substring match on action — `task.` covers task.created/updated/etc.
  action: z.string().max(120).optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  // Pagination — cursor is the previous-page's last item id.
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});

export const auditEntry = z.object({
  id: z.string(),
  action: z.string(),
  actorId: z.string().nullable(),
  actorName: z.string().nullable(),
  taskId: z.string().nullable(),
  taskTitle: z.string().nullable(),
  teamId: z.string().nullable(),
  teamName: z.string().nullable(),
  meta: z.unknown(),
  createdAt: z.string(),
});

export const auditPage = z.object({
  items: z.array(auditEntry),
  nextCursor: z.string().nullable(),
});

export type AuditQuery = z.infer<typeof auditQuery>;
export type AuditEntry = z.infer<typeof auditEntry>;

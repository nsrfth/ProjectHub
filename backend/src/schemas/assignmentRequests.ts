import { z } from 'zod';

// v-next (cross-unit task assignment workflow), Slice 5. Zod is the single
// source of truth for validation AND the OpenAPI doc. Output dates are ISO
// strings (the codebase convention — see schemas/subtasks.ts), so the route
// layer maps Prisma Date fields through view() before sending.

export const createAssignmentRequestBody = z.object({
  // The person the requester wanted to assign (advisory — the approver confirms
  // or overrides). The service classifies THIS person to derive the target
  // unit/division and the approver.
  proposedId: z.string().min(1),
});

export const assignAssignmentRequestBody = z.object({
  assigneeId: z.string().min(1),
});

export const forwardAssignmentRequestBody = z.object({
  toDeptManagerId: z.string().min(1),
});

export const declineAssignmentRequestBody = z.object({
  reason: z.string().min(1).max(1000),
});

export const assignmentRequestResponse = z.object({
  id: z.string(),
  teamId: z.string(),
  taskId: z.string(),
  projectId: z.string(),
  requesterId: z.string(),
  targetType: z.enum(['GROUP', 'TEAM']),
  targetId: z.string(),
  proposedId: z.string().nullable(),
  status: z.enum(['REQUESTED', 'APPROVED', 'FORWARDED', 'ASSIGNED', 'DECLINED', 'EXPIRED']),
  approverId: z.string().nullable(),
  forwardedToId: z.string().nullable(),
  assigneeId: z.string().nullable(),
  declineReason: z.string().nullable(),
  expiresAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  decidedAt: z.string().nullable(),
});

// Enriched inbox row — carries the display names the approver UI needs.
export const assignmentApprovalView = z.object({
  id: z.string(),
  status: z.enum(['REQUESTED', 'APPROVED', 'FORWARDED', 'ASSIGNED', 'DECLINED', 'EXPIRED']),
  taskId: z.string(),
  taskTitle: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  teamId: z.string(),
  requesterId: z.string(),
  requesterName: z.string(),
  proposedId: z.string().nullable(),
  proposedName: z.string().nullable(),
  targetType: z.enum(['GROUP', 'TEAM']),
  targetId: z.string(),
  expiresAt: z.string(),
  createdAt: z.string(),
});

export const assignmentApprovalsResponse = z.object({
  items: z.array(assignmentApprovalView),
});

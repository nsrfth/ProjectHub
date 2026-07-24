import { api } from '@/lib/api';

// v-next (P2): cross-unit task assignment workflow — the requester and approver
// surfaces. Mirrors features/projects/grantsApi.ts.

export type AssignmentRequestStatus =
  | 'REQUESTED'
  | 'APPROVED'
  | 'FORWARDED'
  | 'ASSIGNED'
  | 'DECLINED'
  | 'EXPIRED';

/** Enriched inbox row (names resolved server-side — see AssignmentApprovalView). */
export interface AssignmentApproval {
  id: string;
  status: AssignmentRequestStatus;
  taskId: string;
  taskTitle: string;
  projectId: string;
  projectName: string;
  teamId: string;
  requesterId: string;
  requesterName: string;
  proposedId: string | null;
  proposedName: string | null;
  targetType: 'GROUP' | 'TEAM';
  targetId: string;
  expiresAt: string;
  createdAt: string;
}

/** File a request when a direct assign returned ASSIGNMENT_REQUEST_REQUIRED. */
export async function createAssignmentRequest(
  teamId: string,
  projectId: string,
  taskId: string,
  proposedId: string,
): Promise<{ id: string }> {
  const res = await api.post(
    `/teams/${teamId}/projects/${projectId}/tasks/${taskId}/assignment-requests`,
    { proposedId },
  );
  return res.data as { id: string };
}

export async function listMyAssignmentApprovals(): Promise<AssignmentApproval[]> {
  const res = await api.get('/me/assignment-approvals');
  return res.data.items as AssignmentApproval[];
}

export async function approveAssignmentRequest(reqId: string): Promise<void> {
  await api.post(`/me/assignment-approvals/${reqId}/approve`);
}

export async function assignAssignmentRequest(reqId: string, assigneeId: string): Promise<void> {
  await api.post(`/me/assignment-approvals/${reqId}/assign`, { assigneeId });
}

export async function forwardAssignmentRequest(reqId: string, toDeptManagerId: string): Promise<void> {
  await api.post(`/me/assignment-approvals/${reqId}/forward`, { toDeptManagerId });
}

export async function declineAssignmentRequest(reqId: string, reason: string): Promise<void> {
  await api.post(`/me/assignment-approvals/${reqId}/decline`, { reason });
}

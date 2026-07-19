import { api } from '@/lib/api';

// v2.8 (Phases 2+3): the unified sharing surface.

export type GrantSubjectType = 'USER' | 'GROUP' | 'TEAM' | 'ORG_UNIT';
export type GrantLevel = 'READ' | 'WRITE';
export type GrantStatus = 'PENDING' | 'ACTIVE' | 'DECLINED';

export interface ProjectGrant {
  id: string;
  projectId: string;
  subjectType: GrantSubjectType;
  subjectId: string;
  subjectName: string;
  level: GrantLevel;
  status: GrantStatus;
  source: string | null;
  grantedByName: string | null;
  grantedAt: string;
  expiresAt: string | null;
}

export interface PendingApproval extends ProjectGrant {
  projectName: string;
  teamName: string;
}

export async function listGrants(teamId: string, projectId: string): Promise<ProjectGrant[]> {
  const res = await api.get(`/teams/${teamId}/projects/${projectId}/grants`);
  return res.data.items as ProjectGrant[];
}

export async function createGrant(
  teamId: string,
  projectId: string,
  input: { subjectType: GrantSubjectType; subjectId: string; level: GrantLevel },
): Promise<ProjectGrant> {
  const res = await api.post(`/teams/${teamId}/projects/${projectId}/grants`, input);
  return res.data as ProjectGrant;
}

export async function revokeGrant(teamId: string, projectId: string, grantId: string): Promise<void> {
  await api.delete(`/teams/${teamId}/projects/${projectId}/grants/${grantId}`);
}

export async function listMyApprovals(): Promise<PendingApproval[]> {
  const res = await api.get('/me/grant-approvals');
  return res.data.items as PendingApproval[];
}

export async function decideGrant(grantId: string, decision: 'accept' | 'decline'): Promise<ProjectGrant> {
  const res = await api.post(`/me/grant-approvals/${grantId}`, { decision });
  return res.data as ProjectGrant;
}

import { api } from '@/lib/api';

export type TeamRole = 'MANAGER' | 'MEMBER';

export interface Team {
  id: string;
  name: string;
  slug: string;
  // v1.12: per-team accent colour shown on kanban cards + calendar views.
  // Hex (#RRGGBB); null = default slate.
  color: string | null;
  createdAt: string;
  myRole: TeamRole;
}

export interface TeamMember {
  userId: string;
  email: string;
  name: string;
  role: TeamRole;
  // v1.23: custom role pointer + joined name. Null when the membership
  // still relies on the legacy `role` enum fallback (rare; only during
  // migration).
  roleId: string | null;
  roleName: string | null;
  joinedAt: string;
}

export interface TeamDeleteBlockers {
  canDelete: boolean;
  projectCount: number;
  taskCount: number;
  memberCount: number;
  reasons: string[];
}

export interface TeamCapabilities {
  editDetails: boolean;
  deleteTeam: boolean;
  manageGroups: boolean;
}

export interface TeamDetail extends Team {
  members: TeamMember[];
  capabilities: TeamCapabilities;
  deleteBlockers: TeamDeleteBlockers | null;
}

export async function listMyTeams(): Promise<Team[]> {
  return (await api.get<Team[]>('/teams')).data;
}

export async function createTeam(input: { name: string; slug: string; color?: string }): Promise<Team> {
  return (await api.post<Team>('/teams', input)).data;
}

export async function getTeam(teamId: string): Promise<TeamDetail> {
  return (await api.get<TeamDetail>(`/teams/${teamId}`)).data;
}

// v1.12: PATCH team metadata. color: null explicitly clears it.
export async function updateTeam(
  teamId: string,
  input: { name?: string; slug?: string; color?: string | null },
): Promise<Team> {
  return (await api.patch<Team>(`/teams/${teamId}`, input)).data;
}

export async function addMember(
  teamId: string,
  input: { email: string; role: TeamRole },
): Promise<TeamMember> {
  return (await api.post<TeamMember>(`/teams/${teamId}/members`, input)).data;
}

// v1.23: accepts EITHER the legacy role enum OR a custom roleId. Both
// trigger the same PATCH but the server expects exactly one.
export async function updateMemberRole(
  teamId: string,
  userId: string,
  patch: { role: TeamRole } | { roleId: string },
): Promise<TeamMember> {
  return (await api.patch<TeamMember>(`/teams/${teamId}/members/${userId}`, patch)).data;
}

export async function removeMember(teamId: string, userId: string): Promise<void> {
  await api.delete(`/teams/${teamId}/members/${userId}`);
}

export async function deleteTeam(teamId: string): Promise<void> {
  await api.delete(`/teams/${teamId}`);
}

import { api } from '@/lib/api';

export type TeamRole = 'MANAGER' | 'MEMBER';

export interface Team {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  myRole: TeamRole;
}

export interface TeamMember {
  userId: string;
  email: string;
  name: string;
  role: TeamRole;
  joinedAt: string;
}

export interface TeamDetail extends Team {
  members: TeamMember[];
}

export async function listMyTeams(): Promise<Team[]> {
  return (await api.get<Team[]>('/teams')).data;
}

export async function createTeam(input: { name: string; slug: string }): Promise<Team> {
  return (await api.post<Team>('/teams', input)).data;
}

export async function getTeam(teamId: string): Promise<TeamDetail> {
  return (await api.get<TeamDetail>(`/teams/${teamId}`)).data;
}

export async function addMember(
  teamId: string,
  input: { email: string; role: TeamRole },
): Promise<TeamMember> {
  return (await api.post<TeamMember>(`/teams/${teamId}/members`, input)).data;
}

export async function updateMemberRole(
  teamId: string,
  userId: string,
  role: TeamRole,
): Promise<TeamMember> {
  return (await api.patch<TeamMember>(`/teams/${teamId}/members/${userId}`, { role })).data;
}

export async function removeMember(teamId: string, userId: string): Promise<void> {
  await api.delete(`/teams/${teamId}/members/${userId}`);
}

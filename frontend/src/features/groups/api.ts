import { api } from '@/lib/api';

export interface UserGroupSummary {
  id: string;
  teamId: string;
  name: string;
  description: string | null;
  memberCount: number;
  grantedProjectCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface UserGroupMember {
  userId: string;
  email: string;
  name: string;
  addedAt: string;
}

export interface UserGroupProject {
  projectId: string;
  name: string;
  ownerId: string | null;
  grantedAt: string;
}

export interface UserGroupDetail extends UserGroupSummary {
  members: UserGroupMember[];
  projects: UserGroupProject[];
}

export async function listGroups(teamId: string): Promise<UserGroupSummary[]> {
  return (await api.get<{ items: UserGroupSummary[] }>(`/teams/${teamId}/groups`)).data.items;
}

export async function createGroup(
  teamId: string,
  input: { name: string; description?: string | null },
): Promise<UserGroupDetail> {
  return (await api.post<UserGroupDetail>(`/teams/${teamId}/groups`, input)).data;
}

export async function getGroup(teamId: string, groupId: string): Promise<UserGroupDetail> {
  return (await api.get<UserGroupDetail>(`/teams/${teamId}/groups/${groupId}`)).data;
}

export async function updateGroup(
  teamId: string,
  groupId: string,
  input: { name?: string; description?: string | null },
): Promise<UserGroupDetail> {
  return (await api.patch<UserGroupDetail>(`/teams/${teamId}/groups/${groupId}`, input)).data;
}

export async function deleteGroup(teamId: string, groupId: string): Promise<void> {
  await api.delete(`/teams/${teamId}/groups/${groupId}`);
}

export async function addGroupMembers(
  teamId: string,
  groupId: string,
  userIds: string[],
): Promise<UserGroupDetail> {
  return (
    await api.post<UserGroupDetail>(`/teams/${teamId}/groups/${groupId}/members`, { userIds })
  ).data;
}

export async function removeGroupMember(
  teamId: string,
  groupId: string,
  userId: string,
): Promise<void> {
  await api.delete(`/teams/${teamId}/groups/${groupId}/members/${userId}`);
}

export async function setGroupProjects(
  teamId: string,
  groupId: string,
  projectIds: string[],
): Promise<UserGroupDetail> {
  return (
    await api.put<UserGroupDetail>(`/teams/${teamId}/groups/${groupId}/projects`, { projectIds })
  ).data;
}

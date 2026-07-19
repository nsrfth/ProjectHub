import { api } from '@/lib/api';

export type GroupAccessLevel = 'FULL' | 'READONLY';
export type GroupInviteStatus = 'PENDING' | 'ACCEPTED' | 'DECLINED';
// v2.10: UNIT = department (اداره کل) — direct membership, one per person;
// COLLAB = collaboration group, the original invitation-based behaviour.
export type UserGroupKind = 'UNIT' | 'COLLAB';
export type GroupRole = 'MANAGER' | 'MEMBER';

export interface UserGroupSummary {
  id: string;
  teamId: string;
  name: string;
  description: string | null;
  memberCount: number;
  grantedProjectCount: number;
  createdAt: string;
  updatedAt: string;
  kind: UserGroupKind;
}

export interface UserGroupMember {
  id: string;
  userId: string;
  email: string;
  name: string;
  accessLevel: GroupAccessLevel;
  status: GroupInviteStatus;
  external: boolean;
  invitedAt: string;
  respondedAt: string | null;
  role: GroupRole;
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

export interface GroupInvite {
  id: string;
  groupId: string;
  groupName: string;
  teamId: string;
  teamName: string;
  accessLevel: GroupAccessLevel;
  invitedAt: string;
  invitedByName: string | null;
}

export interface UserSearchHit {
  id: string;
  email: string;
  name: string;
}

export async function listGroups(teamId: string): Promise<UserGroupSummary[]> {
  return (await api.get<{ items: UserGroupSummary[] }>(`/teams/${teamId}/groups`)).data.items;
}

export async function searchUsers(teamId: string, q: string): Promise<UserSearchHit[]> {
  return (
    await api.get<{ items: UserSearchHit[] }>(`/teams/${teamId}/groups/user-search`, { params: { q } })
  ).data.items;
}

export async function createGroup(
  teamId: string,
  input: { name: string; description?: string | null; kind?: UserGroupKind },
): Promise<UserGroupDetail> {
  return (await api.post<UserGroupDetail>(`/teams/${teamId}/groups`, input)).data;
}

export async function getGroup(teamId: string, groupId: string): Promise<UserGroupDetail> {
  return (await api.get<UserGroupDetail>(`/teams/${teamId}/groups/${groupId}`)).data;
}

export async function deleteGroup(teamId: string, groupId: string): Promise<void> {
  await api.delete(`/teams/${teamId}/groups/${groupId}`);
}

export async function addGroupMember(
  teamId: string,
  groupId: string,
  userId: string,
  accessLevel: GroupAccessLevel = 'FULL',
  role: GroupRole = 'MEMBER',
): Promise<UserGroupDetail> {
  return (
    await api.post<UserGroupDetail>(`/teams/${teamId}/groups/${groupId}/members`, {
      userId,
      accessLevel,
      role,
    })
  ).data;
}

// v2.10: designate / demote the department director (unit MANAGER).
export async function updateGroupMemberRole(
  teamId: string,
  groupId: string,
  userId: string,
  role: GroupRole,
): Promise<UserGroupDetail> {
  return (
    await api.patch<UserGroupDetail>(
      `/teams/${teamId}/groups/${groupId}/members/${userId}/role`,
      { role },
    )
  ).data;
}

export async function updateGroupMemberAccess(
  teamId: string,
  groupId: string,
  userId: string,
  accessLevel: GroupAccessLevel,
): Promise<UserGroupDetail> {
  return (
    await api.patch<UserGroupDetail>(`/teams/${teamId}/groups/${groupId}/members/${userId}`, {
      accessLevel,
    })
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

export async function listGroupInvites(): Promise<GroupInvite[]> {
  return (await api.get<{ items: GroupInvite[] }>('/me/group-invites')).data.items;
}

export async function acceptGroupInvite(memberId: string): Promise<void> {
  await api.post(`/me/group-invites/${memberId}/accept`);
}

export async function declineGroupInvite(memberId: string): Promise<void> {
  await api.post(`/me/group-invites/${memberId}/decline`);
}

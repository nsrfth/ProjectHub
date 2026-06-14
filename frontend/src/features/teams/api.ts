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
  disabled: boolean;
  locked: boolean;
  external: boolean;
  groupAccessLevel: 'FULL' | 'READONLY' | null;
}

export interface TeamDeleteBlockers {
  canDelete: boolean;
  projectCount: number;
  taskCount: number;
  memberCount: number;
  reasons: string[];
}

export interface MemberRemovalProjectRef {
  id: string;
  name: string;
}

export interface MemberRemovalBlockers {
  canRemove: boolean;
  ownedProjectCount: number;
  accountableProjectCount: number;
  ownedProjects: MemberRemovalProjectRef[];
  accountableProjects: MemberRemovalProjectRef[];
  reasons: string[];
}

export interface RemoveMemberOptions {
  reassignOwnerTo?: string;
  force?: boolean;
}

export interface TeamCapabilities {
  editDetails: boolean;
  deleteTeam: boolean;
  manageGroups: boolean;
  manageCustomFields: boolean;
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

export type TeamMemberKind = 'member' | 'external' | 'all';
export type TeamMemberStatusFilter = 'active' | 'disabled' | 'locked';
export type TeamMemberSortBy = 'name' | 'email' | 'joinedAt' | 'role';
export type SortDir = 'asc' | 'desc';

export interface PagedResult<T> {
  items: T[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export interface ListTeamMembersParams {
  page?: number;
  pageSize?: number;
  search?: string;
  role?: TeamRole;
  status?: TeamMemberStatusFilter;
  kind?: TeamMemberKind;
  sortBy?: TeamMemberSortBy;
  sortDir?: SortDir;
}

export async function listTeamMembers(
  teamId: string,
  opts: ListTeamMembersParams = {},
): Promise<PagedResult<TeamMember>> {
  const params: Record<string, string> = {};
  if (opts.page != null) params.page = String(opts.page);
  if (opts.pageSize != null) params.pageSize = String(opts.pageSize);
  if (opts.search) params.search = opts.search;
  if (opts.role) params.role = opts.role;
  if (opts.status) params.status = opts.status;
  if (opts.kind) params.kind = opts.kind;
  if (opts.sortBy) params.sortBy = opts.sortBy;
  if (opts.sortDir) params.sortDir = opts.sortDir;
  return (await api.get<PagedResult<TeamMember>>(`/teams/${teamId}/members`, { params })).data;
}

/** Team members only (excludes external accessors), up to 100 — for assignee pickers. */
export async function listTeamMembersForAssignees(teamId: string): Promise<TeamMember[]> {
  const page = await listTeamMembers(teamId, {
    kind: 'member',
    pageSize: 100,
    sortBy: 'name',
    sortDir: 'asc',
  });
  return page.items;
}

// v1.12: PATCH team metadata. color: null explicitly clears it.
export async function updateTeam(
  teamId: string,
  input: { name?: string; slug?: string; color?: string | null },
): Promise<Team> {
  return (await api.patch<Team>(`/teams/${teamId}`, input)).data;
}

export interface TeamUserSearchHit {
  id: string;
  email: string;
  name: string;
  alreadyMember: boolean;
}

export async function searchAddableUsers(teamId: string, q: string): Promise<TeamUserSearchHit[]> {
  const res = await api.get<{ items: TeamUserSearchHit[] }>(
    `/teams/${teamId}/members/user-search`,
    { params: { q } },
  );
  return res.data.items;
}

export async function addMember(
  teamId: string,
  input: ({ role: TeamRole } & ({ email: string } | { userId: string })),
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

export async function getMemberRemovalBlockers(
  teamId: string,
  userId: string,
): Promise<MemberRemovalBlockers> {
  return (
    await api.get<MemberRemovalBlockers>(`/teams/${teamId}/members/${userId}/removal-blockers`)
  ).data;
}

export async function removeMember(
  teamId: string,
  userId: string,
  opts?: RemoveMemberOptions,
): Promise<void> {
  await api.delete(`/teams/${teamId}/members/${userId}`, { data: opts });
}

export async function deleteTeam(teamId: string): Promise<void> {
  await api.delete(`/teams/${teamId}`);
}

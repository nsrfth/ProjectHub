import { api } from '@/lib/api';

export type GlobalRole = 'ADMIN' | 'MEMBER';
export type AuthSource = 'LOCAL' | 'LDAP' | 'SCIM';

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  globalRole: GlobalRole;
  emailVerifiedAt: string | null;
  createdAt: string;
  membershipCount: number;
  directoryId: string | null;
  authSource: AuthSource;
  ldapUsername: string | null;
  userPrincipalName: string | null;
  department: string | null;
  jobTitle: string | null;
  managerName: string | null;
  ldapSyncedAt: string | null;
  directoryName: string | null;
  directoryActive: boolean;
  disabledAt: string | null;
  lockedUntil: string | null;
}

export interface AdminTeam {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  memberCount: number;
  projectCount: number;
}

export interface PagedResult<T> {
  items: T[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export type UserStatusFilter = 'active' | 'disabled' | 'locked';
export type UserSortBy = 'name' | 'email' | 'createdAt' | 'lastSynced';
export type SortDir = 'asc' | 'desc';

export interface ListUsersParams {
  page?: number;
  pageSize?: number;
  search?: string;
  role?: GlobalRole;
  authSource?: AuthSource;
  status?: UserStatusFilter;
  directoryId?: string;
  sortBy?: UserSortBy;
  sortDir?: SortDir;
}

export async function listUsers(opts: ListUsersParams = {}): Promise<PagedResult<AdminUser>> {
  const params: Record<string, string> = {};
  if (opts.page != null) params.page = String(opts.page);
  if (opts.pageSize != null) params.pageSize = String(opts.pageSize);
  if (opts.search) params.search = opts.search;
  if (opts.role) params.role = opts.role;
  if (opts.authSource) params.authSource = opts.authSource;
  if (opts.status) params.status = opts.status;
  if (opts.directoryId) params.directoryId = opts.directoryId;
  if (opts.sortBy) params.sortBy = opts.sortBy;
  if (opts.sortDir) params.sortDir = opts.sortDir;
  return (await api.get<PagedResult<AdminUser>>('/admin/users', { params })).data;
}

export async function updateUserRole(userId: string, globalRole: GlobalRole): Promise<AdminUser> {
  return (await api.patch<AdminUser>(`/admin/users/${userId}`, { globalRole })).data;
}

export async function listTeams(opts?: { cursor?: string; limit?: number }): Promise<Page<AdminTeam>> {
  const params: Record<string, string> = {};
  if (opts?.cursor) params.cursor = opts.cursor;
  if (opts?.limit) params.limit = String(opts.limit);
  return (await api.get<Page<AdminTeam>>('/admin/teams', { params })).data;
}

export async function deleteTeam(teamId: string): Promise<void> {
  await api.delete(`/admin/teams/${teamId}`);
}

export async function deleteUser(userId: string): Promise<void> {
  await api.delete(`/admin/users/${userId}`);
}

// v1.26: admin-driven user provisioning. password omitted => server
// generates and returns it once in `generatedPassword`. emailVerified
// defaults to true on the server side (admin vouches for the address).
export interface CreateUserResult {
  user: AdminUser;
  generatedPassword: string | null;
}

export async function createUser(input: {
  email: string;
  name: string;
  password?: string;
  globalRole?: GlobalRole;
  emailVerified?: boolean;
}): Promise<CreateUserResult> {
  return (await api.post<CreateUserResult>('/admin/users', input)).data;
}

// v1.32.0: admin-initiated password reset. Omit `password` for a server-
// generated value returned once. 409 when the target is directory-owned.
export interface ResetPasswordResult {
  generatedPassword: string | null;
}

export async function resetUserPassword(
  userId: string,
  password?: string,
): Promise<ResetPasswordResult> {
  return (
    await api.post<ResetPasswordResult>(`/admin/users/${userId}/password`, {
      ...(password ? { password } : {}),
    })
  ).data;
}

export async function refreshLdapUser(userId: string): Promise<AdminUser> {
  return (await api.post<AdminUser>(`/admin/users/${userId}/ldap/sync`)).data;
}

export async function testLdapUserAuth(userId: string, password: string): Promise<void> {
  await api.post(`/admin/users/${userId}/ldap/test-auth`, { password });
}

export async function setUserDisabled(userId: string, disabled: boolean): Promise<AdminUser> {
  return (await api.post<AdminUser>(`/admin/users/${userId}/disable`, { disabled })).data;
}

export async function unlockUser(userId: string): Promise<AdminUser> {
  return (await api.post<AdminUser>(`/admin/users/${userId}/unlock`)).data;
}

export async function forceLogoutUser(userId: string): Promise<AdminUser> {
  return (await api.post<AdminUser>(`/admin/users/${userId}/force-logout`)).data;
}

export interface UpdateUserProfileInput {
  name?: string;
  email?: string;
  department?: string | null;
  jobTitle?: string | null;
}

export async function updateUserProfile(
  userId: string,
  input: UpdateUserProfileInput,
): Promise<AdminUser> {
  return (await api.patch<AdminUser>(`/admin/users/${userId}/profile`, input)).data;
}

// v2.19: project ↔ department administration.
export interface AdminDepartment {
  id: string;
  name: string;
  teamId: string;
  teamName: string;
  memberCount: number;
}

export interface AdminProjectDepartment {
  projectId: string;
  projectName: string;
  teamId: string;
  teamName: string;
  department: { id: string; name: string } | null;
}

export interface TransferDepartmentResult {
  projectId: string;
  projectName: string;
  from: { id: string; name: string } | null;
  to: { id: string; name: string };
  grantsMoved: number;
}

export async function listDepartments(): Promise<AdminDepartment[]> {
  return (await api.get<AdminDepartment[]>('/admin/departments')).data;
}

export async function listProjectDepartments(): Promise<AdminProjectDepartment[]> {
  return (await api.get<AdminProjectDepartment[]>('/admin/project-departments')).data;
}

export async function transferProjectDepartment(
  projectId: string,
  toGroupId: string,
): Promise<TransferDepartmentResult> {
  return (
    await api.post<TransferDepartmentResult>(
      `/admin/projects/${projectId}/transfer-department`,
      { toGroupId },
    )
  ).data;
}

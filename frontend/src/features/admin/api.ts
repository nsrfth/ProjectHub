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
}

export interface AdminTeam {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  memberCount: number;
  projectCount: number;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export async function listUsers(opts?: { cursor?: string; limit?: number }): Promise<Page<AdminUser>> {
  const params: Record<string, string> = {};
  if (opts?.cursor) params.cursor = opts.cursor;
  if (opts?.limit) params.limit = String(opts.limit);
  return (await api.get<Page<AdminUser>>('/admin/users', { params })).data;
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

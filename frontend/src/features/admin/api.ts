import { api } from '@/lib/api';

export type GlobalRole = 'ADMIN' | 'MEMBER';

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  globalRole: GlobalRole;
  emailVerifiedAt: string | null;
  createdAt: string;
  membershipCount: number;
}

export interface AdminTeam {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  memberCount: number;
  projectCount: number;
}

export async function listUsers(): Promise<AdminUser[]> {
  return (await api.get<AdminUser[]>('/admin/users')).data;
}

export async function updateUserRole(userId: string, globalRole: GlobalRole): Promise<AdminUser> {
  return (await api.patch<AdminUser>(`/admin/users/${userId}`, { globalRole })).data;
}

export async function listTeams(): Promise<AdminTeam[]> {
  return (await api.get<AdminTeam[]>('/admin/teams')).data;
}

export async function deleteTeam(teamId: string): Promise<void> {
  await api.delete(`/admin/teams/${teamId}`);
}

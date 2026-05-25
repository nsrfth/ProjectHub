import { api } from '@/lib/api';

// v1.23: per-team custom roles + permission matrix.

export interface Role {
  id: string;
  teamId: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: string[];
  membershipCount: number;
  createdAt: string;
  updatedAt: string;
}

export async function listRoles(teamId: string): Promise<{ items: Role[] }> {
  return (await api.get<{ items: Role[] }>(`/teams/${teamId}/roles`)).data;
}

export async function getRole(teamId: string, roleId: string): Promise<Role> {
  return (await api.get<Role>(`/teams/${teamId}/roles/${roleId}`)).data;
}

export async function createRole(
  teamId: string,
  input: { name: string; description?: string | null; permissions: string[] },
): Promise<Role> {
  return (await api.post<Role>(`/teams/${teamId}/roles`, input)).data;
}

export async function updateRole(
  teamId: string,
  roleId: string,
  input: { name?: string; description?: string | null },
): Promise<Role> {
  return (await api.patch<Role>(`/teams/${teamId}/roles/${roleId}`, input)).data;
}

export async function setRolePermissions(
  teamId: string,
  roleId: string,
  permissions: string[],
): Promise<Role> {
  return (await api.put<Role>(`/teams/${teamId}/roles/${roleId}/permissions`, {
    permissions,
  })).data;
}

export async function deleteRole(teamId: string, roleId: string): Promise<void> {
  await api.delete(`/teams/${teamId}/roles/${roleId}`);
}

// Pulled separately from /system/permissions — feeds the matrix UI.
export interface PermissionCatalog {
  permissions: string[];
  groups: Record<string, string[]>;
}

export async function fetchPermissionCatalog(): Promise<PermissionCatalog> {
  return (await api.get<PermissionCatalog>('/system/permissions')).data;
}

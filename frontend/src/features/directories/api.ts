import { api } from '@/lib/api';

export type DirectoryKind = 'LDAP' | 'SCIM';
export type DirectoryGlobalRole = 'ADMIN' | 'MEMBER';
export type DirectoryTeamRole = 'MANAGER' | 'MEMBER';

export interface Directory {
  id: string;
  name: string;
  slug: string;
  kind: DirectoryKind;
  host: string | null;
  port: number | null;
  useTLS: boolean;
  bindDN: string | null;
  // Server-side projection of bindPasswordEnc — true if a ciphertext is
  // stored, never the plaintext. Used to show "Password set" vs "Not set".
  hasBindPassword: boolean;
  baseDN: string | null;
  userFilter: string | null;
  groupFilter: string | null;
  userIdAttr: string;
  emailAttr: string;
  nameAttr: string;
  groupMemberAttr: string;
  allowJIT: boolean;
  syncRolesFromGroups: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DirectoryCreateInput {
  name: string;
  slug: string;
  kind?: DirectoryKind;
  host?: string;
  port?: number;
  useTLS?: boolean;
  bindDN?: string;
  bindPassword?: string;
  baseDN?: string;
  userFilter?: string;
  groupFilter?: string;
  userIdAttr?: string;
  emailAttr?: string;
  nameAttr?: string;
  groupMemberAttr?: string;
  allowJIT?: boolean;
  syncRolesFromGroups?: boolean;
}

export type DirectoryUpdateInput = Partial<DirectoryCreateInput>;

export interface GroupMapping {
  id: string;
  directoryId: string;
  externalGroupDn: string;
  globalRole: DirectoryGlobalRole | null;
  teamId: string | null;
  teamRole: DirectoryTeamRole | null;
}

export interface GroupMappingCreateInput {
  externalGroupDn: string;
  globalRole?: DirectoryGlobalRole | null;
  teamId?: string | null;
  teamRole?: DirectoryTeamRole | null;
}

export interface TestResult {
  ok: boolean;
  message: string;
  sampleUserCount?: number;
}

export async function listDirectories(): Promise<{ items: Directory[] }> {
  return (await api.get<{ items: Directory[] }>('/settings/directories')).data;
}

export async function createDirectory(input: DirectoryCreateInput): Promise<Directory> {
  return (await api.post<Directory>('/settings/directories', input)).data;
}

export async function updateDirectory(
  directoryId: string,
  input: DirectoryUpdateInput,
): Promise<Directory> {
  return (await api.patch<Directory>(`/settings/directories/${directoryId}`, input)).data;
}

export async function deleteDirectory(directoryId: string): Promise<void> {
  await api.delete(`/settings/directories/${directoryId}`);
}

export async function testDirectory(
  directoryId: string,
  bindPassword?: string,
): Promise<TestResult> {
  return (
    await api.post<TestResult>(`/settings/directories/${directoryId}/test`, {
      bindPassword,
    })
  ).data;
}

export async function listMappings(directoryId: string): Promise<{ items: GroupMapping[] }> {
  return (
    await api.get<{ items: GroupMapping[] }>(
      `/settings/directories/${directoryId}/mappings`,
    )
  ).data;
}

export async function createMapping(
  directoryId: string,
  input: GroupMappingCreateInput,
): Promise<GroupMapping> {
  return (
    await api.post<GroupMapping>(
      `/settings/directories/${directoryId}/mappings`,
      input,
    )
  ).data;
}

export async function deleteMapping(directoryId: string, mappingId: string): Promise<void> {
  await api.delete(`/settings/directories/${directoryId}/mappings/${mappingId}`);
}

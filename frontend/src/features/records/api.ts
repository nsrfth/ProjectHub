import { api } from '@/lib/api';

// v2.4 (PMIS R8 — record framework): typed client for the team record-type
// catalog + per-project records. Mirrors backend/src/schemas/records.ts.

export type RecordTypeKind = 'BUILTIN' | 'CUSTOM';

export interface RecordTypeTransition {
  from: string;
  to: string;
  permission?: string;
}

export interface RecordType {
  id: string;
  teamId: string | null;
  key: string;
  name: string;
  kind: RecordTypeKind;
  statusSet: string[];
  transitions: RecordTypeTransition[];
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface PmisRecord {
  id: string;
  teamId: string;
  projectId: string;
  recordTypeId: string;
  recordTypeKey: string;
  recordTypeName: string;
  reference: string;
  title: string;
  description: string | null;
  status: string;
  fieldValues: Record<string, unknown>;
  assigneeId: string | null;
  assigneeName: string | null;
  dueDate: string | null;
  closedAt: string | null;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRecordInput {
  recordTypeId: string;
  title: string;
  description?: string | null;
  status?: string;
  assigneeId?: string | null;
  dueDate?: string | null;
}

export interface ListRecordsParams {
  typeKey?: string;
  status?: string;
}

export async function listRecordTypes(teamId: string): Promise<RecordType[]> {
  return (await api.get<{ items: RecordType[] }>(`/teams/${teamId}/record-types`)).data.items;
}

const base = (teamId: string, projectId: string): string =>
  `/teams/${teamId}/projects/${projectId}/records`;

export async function listRecords(
  teamId: string,
  projectId: string,
  params: ListRecordsParams = {},
): Promise<PmisRecord[]> {
  return (await api.get<{ items: PmisRecord[] }>(base(teamId, projectId), { params })).data.items;
}
export async function createRecord(
  teamId: string,
  projectId: string,
  input: CreateRecordInput,
): Promise<PmisRecord> {
  return (await api.post<PmisRecord>(base(teamId, projectId), input)).data;
}
export async function transitionRecord(
  teamId: string,
  projectId: string,
  id: string,
  toStatus: string,
): Promise<PmisRecord> {
  return (await api.post<PmisRecord>(`${base(teamId, projectId)}/${id}/transition`, { toStatus }))
    .data;
}
export async function deleteRecord(teamId: string, projectId: string, id: string): Promise<void> {
  await api.delete(`${base(teamId, projectId)}/${id}`);
}

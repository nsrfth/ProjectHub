import { api } from '@/lib/api';

// v1.34: per-project bucket grouping. Backend contract documented in
// CHANGELOG v1.34.0; this client is a thin wrapper that mirrors the
// route shape exactly.

export interface Bucket {
  id: string;
  projectId: string;
  name: string;
  order: number;
  createdAt: string;
  updatedAt: string;
}

export async function listBuckets(teamId: string, projectId: string): Promise<Bucket[]> {
  return (
    await api.get<Bucket[]>(`/teams/${teamId}/projects/${projectId}/buckets`)
  ).data;
}

export async function createBucket(
  teamId: string,
  projectId: string,
  input: { name: string },
): Promise<Bucket> {
  return (
    await api.post<Bucket>(`/teams/${teamId}/projects/${projectId}/buckets`, input)
  ).data;
}

export async function renameBucket(
  teamId: string,
  bucketId: string,
  input: { name: string },
): Promise<Bucket> {
  return (await api.patch<Bucket>(`/teams/${teamId}/buckets/${bucketId}`, input)).data;
}

// Full-permutation reorder. The backend rejects partial/duplicate/foreign
// id lists with 400 — callers should always send every bucketId currently
// in the project in the desired order.
export async function reorderBuckets(
  teamId: string,
  projectId: string,
  bucketIds: string[],
): Promise<{ items: Bucket[] }> {
  return (
    await api.patch<{ items: Bucket[] }>(
      `/teams/${teamId}/projects/${projectId}/buckets/reorder`,
      { bucketIds },
    )
  ).data;
}

export async function deleteBucket(teamId: string, bucketId: string): Promise<void> {
  await api.delete(`/teams/${teamId}/buckets/${bucketId}`);
}

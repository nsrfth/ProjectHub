import { api } from '@/lib/api';

export interface Attachment {
  id: string;
  taskId: string;
  uploaderId: string;
  uploaderName: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}

export async function listAttachments(
  teamId: string,
  projectId: string,
  taskId: string,
): Promise<Attachment[]> {
  return (
    await api.get<Attachment[]>(
      `/teams/${teamId}/projects/${projectId}/tasks/${taskId}/attachments`,
    )
  ).data;
}

export async function uploadAttachment(
  teamId: string,
  projectId: string,
  taskId: string,
  file: File,
): Promise<Attachment> {
  // FormData lets the browser set the Content-Type with the correct boundary.
  // Axios passes it through untouched when given a FormData payload.
  const fd = new FormData();
  fd.append('file', file);
  return (
    await api.post<Attachment>(
      `/teams/${teamId}/projects/${projectId}/tasks/${taskId}/attachments`,
      fd,
    )
  ).data;
}

export async function deleteAttachment(
  teamId: string,
  projectId: string,
  taskId: string,
  attachmentId: string,
): Promise<void> {
  await api.delete(
    `/teams/${teamId}/projects/${projectId}/tasks/${taskId}/attachments/${attachmentId}`,
  );
}

// Returns a Blob the caller can save with createObjectURL/anchor download.
// We do the fetch through axios so the auth header is attached automatically.
export async function downloadAttachment(
  teamId: string,
  projectId: string,
  taskId: string,
  attachment: Attachment,
): Promise<void> {
  const res = await api.get<Blob>(
    `/teams/${teamId}/projects/${projectId}/tasks/${taskId}/attachments/${attachment.id}/download`,
    { responseType: 'blob' },
  );
  // Synthesize a download click — works in every browser without library help.
  const url = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = url;
  a.download = attachment.filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

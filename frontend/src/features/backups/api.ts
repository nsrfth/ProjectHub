import { api } from '@/lib/api';

// v1.27: client for /api/admin/backups. Admin-only on the server; the page
// also gates display by globalRole === 'ADMIN'.

export interface BackupConfig {
  enabled: boolean;
  intervalHours: number;
  retention: number;
}

export interface BackupFile {
  filename: string;
  sizeBytes: number;
  createdAt: string;
}

export interface BackupsPage {
  config: BackupConfig;
  lastRunAt: string | null;
  nextRunAt: string | null;
  items: BackupFile[];
}

export interface BackupRunResult {
  filename: string;
  sizeBytes: number;
  durationMs: number;
}

export async function fetchBackups(): Promise<BackupsPage> {
  return (await api.get<BackupsPage>('/admin/backups')).data;
}

export async function updateBackupConfig(patch: Partial<BackupConfig>): Promise<BackupConfig> {
  return (await api.put<BackupConfig>('/admin/backups/config', patch)).data;
}

export async function runBackupNow(): Promise<BackupRunResult> {
  // Send an explicit empty JSON body so Fastify accepts the Content-Type;
  // axios with no body otherwise lets the runtime pick a header that Fastify
  // 415s on.
  return (await api.post<BackupRunResult>('/admin/backups/run', {})).data;
}

export async function deleteBackup(filename: string): Promise<void> {
  await api.delete(`/admin/backups/${encodeURIComponent(filename)}`);
}

// Auth on the API is via in-memory Bearer header (refresh cookie only fires
// on /auth/*), so a plain <a download> would send no token and 401. We fetch
// the bytes through the axios client (auth header attached) then trigger a
// blob download. Fine for the file sizes we expect (a typical TaskHub dump
// is well under 100 MB).
export async function downloadBackup(filename: string): Promise<void> {
  const res = await api.get<Blob>(`/admin/backups/${encodeURIComponent(filename)}/download`, {
    responseType: 'blob',
  });
  const url = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

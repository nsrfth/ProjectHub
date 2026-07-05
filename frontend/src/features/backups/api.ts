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

// v2.5.36: online backup (Kopia → Google Drive) policy + live status.
export interface OnlineBackupConfig {
  enabled: boolean;
  provider: 'GDRIVE';
  folderId: string;
  intervalHours: number;
  keepDaily: number;
  keepWeekly: number;
  keepMonthly: number;
}

export interface OnlineBackupStatus {
  configured: boolean;
  serviceAccountUploaded: boolean;
  passwordSet: boolean;
  initialized: boolean;
  reachable: boolean;
  lastSnapshotAt: string | null;
  snapshotCount: number;
  error: string | null;
  detail: string | null;
}

export interface BackupsPage {
  config: BackupConfig;
  lastRunAt: string | null;
  nextRunAt: string | null;
  items: BackupFile[];
  online: OnlineBackupConfig;
  onlineStatus: OnlineBackupStatus;
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

// v2.5.36: update the online backup (Kopia) policy.
export async function updateOnlineBackupConfig(
  patch: Partial<OnlineBackupConfig>,
): Promise<OnlineBackupConfig> {
  return (await api.put<OnlineBackupConfig>('/admin/backups/online', patch)).data;
}

// v2.5.37: upload the Google service-account key.
export async function uploadServiceAccount(file: File): Promise<void> {
  const form = new FormData();
  form.append('file', file);
  await api.post('/admin/backups/online/service-account', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
}

// v2.5.37: set the repository password (write-only).
export async function setRepoPassword(password: string): Promise<void> {
  await api.put('/admin/backups/online/password', { password });
}

// v2.5.37: (re)initialize the repository (connect/create + apply policy).
export async function initializeOnlineBackup(): Promise<void> {
  await api.post('/admin/backups/online/initialize', {});
}

// v2.5.37: run an online snapshot now.
export async function runOnlineBackupNow(): Promise<void> {
  await api.post('/admin/backups/online/run', {});
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

// v1.28: restore an existing dump back into the live database. DESTRUCTIVE —
// the page wraps the call in an explicit confirm. After the request returns
// the browser will see new data on the next refetch; live websockets may
// surface stale state until the user reloads, which the success toast says.
// v1.32.3: response now carries `uploadsRestored` + `secretsApplied` +
// `secretsSidecar` for the new tarball format. Legacy .dump restores
// resolve those to false/null so existing callers keep working.
export interface RestoreResult {
  filename: string;
  durationMs: number;
  uploadsRestored: boolean;
  secretsApplied: boolean;
  secretsSidecar: string | null;
}

export async function restoreBackup(filename: string): Promise<RestoreResult> {
  return (
    await api.post<RestoreResult>(
      `/admin/backups/${encodeURIComponent(filename)}/restore`,
      {},
    )
  ).data;
}

// v1.28: upload a .dump from disk. Returns the on-disk filename the backend
// assigned (server-side rename keeps things sane + prevents collisions).
export async function uploadBackup(file: File): Promise<BackupFile> {
  const form = new FormData();
  form.append('file', file, file.name);
  return (
    await api.post<BackupFile>('/admin/backups/upload', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
  ).data;
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

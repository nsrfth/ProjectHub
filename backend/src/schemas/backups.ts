import { z } from 'zod';

// v1.27: shapes for the /api/admin/backups endpoints.

export const backupConfig = z.object({
  enabled: z.boolean(),
  // 1h..30d. Wider than this is admin gone-wrong territory.
  intervalHours: z.number().int().min(1).max(24 * 30),
  // Keep at least 1; 365 is a generous upper bound to keep disks sane.
  retention: z.number().int().min(1).max(365),
});

export type BackupConfigInput = z.infer<typeof backupConfig>;

// Partial PUT — admin can flip one knob without re-sending the rest.
export const backupConfigPatch = backupConfig.partial();

export const backupFile = z.object({
  filename: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  createdAt: z.string(),
});

// v2.5.36: online backup (Kopia → Google Drive) — admin-tunable policy. Repo
// password + Google service-account are server secrets and are NOT part of this
// (never sent to / stored by the app), only referenced.
export const onlineBackupProvider = z.enum(['GDRIVE']);

export const onlineBackupConfig = z.object({
  enabled: z.boolean(),
  provider: onlineBackupProvider,
  // Google Drive folder id the snapshots live under (shared with the service account).
  folderId: z.string().max(200),
  // Snapshot cadence + retention (mapped to a Kopia policy by kopia-setup.sh).
  intervalHours: z.number().int().min(1).max(24 * 30),
  keepDaily: z.number().int().min(0).max(365),
  keepWeekly: z.number().int().min(0).max(520),
  keepMonthly: z.number().int().min(0).max(240),
});

export type OnlineBackupConfigInput = z.infer<typeof onlineBackupConfig>;
export const onlineBackupConfigPatch = onlineBackupConfig.partial();

// Status the backend derives from the config + the entrypoint's status.json.
export const onlineBackupStatus = z.object({
  // The app has a usable config (enabled + folder set).
  configured: z.boolean(),
  // A Google service-account key has been uploaded.
  serviceAccountUploaded: z.boolean(),
  // A repository password has been set.
  passwordSet: z.boolean(),
  // The Kopia entrypoint reports the repository is connected + policy applied.
  initialized: z.boolean(),
  // A health ping to the Kopia server succeeded (server up + reachable).
  reachable: z.boolean(),
  // Most recent snapshot time + count, from the entrypoint (best-effort).
  lastSnapshotAt: z.string().nullable(),
  snapshotCount: z.number().int().nonnegative(),
  // Last error the entrypoint hit (repo connect / snapshot), if any.
  error: z.string().nullable(),
  // Human-readable one-liner for the UI.
  detail: z.string().nullable(),
});

export const uploadServiceAccountResponse = z.object({ serviceAccountUploaded: z.literal(true) });
export const setRepoPasswordBody = z.object({ password: z.string().min(1).max(512) });
export const onlineActionResponse = z.object({ ok: z.literal(true), queued: z.string() });

export const backupsPage = z.object({
  config: backupConfig,
  lastRunAt: z.string().nullable(),
  // Computed on the server so the UI doesn't need to repeat the (lastRunAt +
  // intervalHours) maths.
  nextRunAt: z.string().nullable(),
  items: z.array(backupFile),
  // v2.5.36: online backup config + live status.
  online: onlineBackupConfig,
  onlineStatus: onlineBackupStatus,
});

export const runBackupResponse = z.object({
  filename: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
});

export const backupFilenameParam = z.object({
  filename: z.string().min(1),
});

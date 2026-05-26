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

export const backupsPage = z.object({
  config: backupConfig,
  lastRunAt: z.string().nullable(),
  // Computed on the server so the UI doesn't need to repeat the (lastRunAt +
  // intervalHours) maths.
  nextRunAt: z.string().nullable(),
  items: z.array(backupFile),
});

export const runBackupResponse = z.object({
  filename: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
});

export const backupFilenameParam = z.object({
  filename: z.string().min(1),
});

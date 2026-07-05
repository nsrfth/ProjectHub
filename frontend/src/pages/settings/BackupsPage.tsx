import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { Navigate } from 'react-router-dom';
import { useAuth } from '@/features/auth/AuthContext';
import {
  deleteBackup,
  downloadBackup,
  fetchBackups,
  restoreBackup,
  runBackupNow,
  updateBackupConfig,
  updateOnlineBackupConfig,
  uploadBackup,
  type BackupFile,
  type BackupsPage as BackupsPageData,
} from '@/features/backups/api';

// v1.27: admin-only page to configure automatic Postgres backups + view/run/
// download/delete the dumps. Admin-only because non-admins should not see
// disk filenames or trigger pg_dump.
//
// Knobs the admin controls:
//   - Enabled: scheduler creates a dump every `intervalHours` (1..720)
//   - Retention: keep last N dumps; the scheduler purges anything older
//
// "Run now" is synchronous — pg_dump for a small instance takes seconds.

function errorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const msg = err.response?.data?.error?.message;
    if (typeof msg === 'string' && msg.length) return msg;
  }
  return fallback;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export default function BackupsPage(): JSX.Element {
  const { user } = useAuth();
  const qc = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ['backups'],
    queryFn: fetchBackups,
    // Refresh on focus so a backup that ran while the page sat in another
    // tab shows up without a manual reload.
    refetchOnWindowFocus: true,
  });

  const [enabled, setEnabled] = useState<boolean>(false);
  const [intervalHours, setIntervalHours] = useState<number>(24);
  const [retention, setRetention] = useState<number>(7);
  const [configError, setConfigError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [runOk, setRunOk] = useState<string | null>(null);

  useEffect(() => {
    if (data) {
      setEnabled(data.config.enabled);
      setIntervalHours(data.config.intervalHours);
      setRetention(data.config.retention);
    }
  }, [data]);

  const saveMut = useMutation({
    mutationFn: () => updateBackupConfig({ enabled, intervalHours, retention }),
    onSuccess: () => {
      setConfigError(null);
      qc.invalidateQueries({ queryKey: ['backups'] });
    },
    onError: (e) => setConfigError(errorMessage(e, 'Could not save')),
  });

  const runMut = useMutation({
    mutationFn: runBackupNow,
    onSuccess: (res) => {
      setRunOk(`Wrote ${res.filename} (${formatBytes(res.sizeBytes)}) in ${(res.durationMs / 1000).toFixed(1)}s`);
      setRunError(null);
      qc.invalidateQueries({ queryKey: ['backups'] });
    },
    onError: (e) => {
      setRunOk(null);
      setRunError(errorMessage(e, 'Backup failed'));
    },
  });

  const deleteMut = useMutation({
    mutationFn: (filename: string) => deleteBackup(filename),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['backups'] }),
  });

  const restoreMut = useMutation({
    mutationFn: (filename: string) => restoreBackup(filename),
    onSuccess: (res) => {
      qc.invalidateQueries();
      // v1.32.3: bundled restores can carry uploads + secrets. Tell the
      // admin what landed so the next-step actions (apply secrets, restart)
      // are explicit instead of buried in CHANGELOG.
      const lines: string[] = [
        `Restore complete: ${res.filename} (${(res.durationMs / 1000).toFixed(1)}s).`,
      ];
      if (res.uploadsRestored) {
        lines.push('Attachment files were restored into the uploads volume.');
      }
      if (res.secretsApplied && res.secretsSidecar) {
        lines.push(
          `Secrets bundle written to backups/${res.secretsSidecar} (chmod 0600). ` +
            'Copy MASTER_KEY / JWT_* lines into .env and restart the backend so ' +
            '2FA secrets, LDAP bind passwords, and existing sessions keep working.',
        );
      }
      lines.push('Reload this page so every tab picks up the restored data.');
      window.alert(lines.join('\n\n'));
    },
    onError: (e) => window.alert(errorMessage(e, 'Restore failed')),
  });

  const uploadMut = useMutation({
    mutationFn: (file: File) => uploadBackup(file),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['backups'] }),
  });

  if (user && user.globalRole !== 'ADMIN') {
    return <Navigate to="/settings" replace />;
  }

  const dirty =
    !!data &&
    (enabled !== data.config.enabled ||
      intervalHours !== data.config.intervalHours ||
      retention !== data.config.retention);

  function submit(e: FormEvent): void {
    e.preventDefault();
    saveMut.mutate();
  }

  return (
    <section className="space-y-6">
      <header>
        <h2 className="text-lg font-semibold mb-1">Automatic backups</h2>
        <p className="text-sm text-text-muted">
          Schedule periodic Postgres dumps. Files are stored on the backend's
          backups volume (<code>/app/backups</code>) and pruned by the
          retention policy below.
        </p>
      </header>

      {isLoading && <p className="text-sm text-slate-400">Loading…</p>}
      {error && <p role="alert" className="text-sm text-danger">{errorMessage(error, 'Could not load backups')}</p>}

      {data && (
        <>
          <form
            onSubmit={submit}
            className="border border-border rounded p-4 space-y-4"
          >
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              <span className="font-medium">Enable scheduled backups</span>
            </label>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <label className="block text-sm">
                <span className="block font-medium mb-1">
                  Period (hours)
                </span>
                <input
                  type="number"
                  min={1}
                  max={24 * 30}
                  step={1}
                  value={intervalHours}
                  onChange={(e) => setIntervalHours(Number(e.target.value))}
                  className="rounded border-border px-2 py-1 border w-32 bg-surface"
                />
                <span className="block text-[11px] text-text-muted mt-1">
                  Run pg_dump every N hours. 24 = daily. Range 1..720.
                </span>
              </label>

              <label className="block text-sm">
                <span className="block font-medium mb-1">
                  Keep last N backups
                </span>
                <input
                  type="number"
                  min={1}
                  max={365}
                  step={1}
                  value={retention}
                  onChange={(e) => setRetention(Number(e.target.value))}
                  className="rounded border-border px-2 py-1 border w-32 bg-surface"
                />
                <span className="block text-[11px] text-text-muted mt-1">
                  Older dumps are deleted after each successful run. Range 1..365.
                </span>
              </label>
            </div>

            {configError && <p role="alert" className="text-xs text-danger">{configError}</p>}

            <div className="flex items-center gap-3">
              <button
                type="submit"
                disabled={saveMut.isPending || !dirty}
                className="bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 rounded px-3 py-1 text-sm font-medium disabled:opacity-50"
              >
                {saveMut.isPending ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button"
                onClick={() => runMut.mutate()}
                disabled={runMut.isPending}
                className="rounded border border-border px-3 py-1 text-sm font-medium hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-50"
              >
                {runMut.isPending ? 'Running…' : 'Run backup now'}
              </button>
              <div className="text-xs text-text-muted">
                <div>
                  Last:{' '}
                  {data.lastRunAt ? new Date(data.lastRunAt).toLocaleString() : 'never'}
                </div>
                <div>
                  Next:{' '}
                  {data.config.enabled && data.nextRunAt
                    ? new Date(data.nextRunAt).toLocaleString()
                    : '—'}
                </div>
              </div>
            </div>

            {runOk && (
              <p className="text-xs text-success">{runOk}</p>
            )}
            {runError && <p role="alert" className="text-xs text-danger">{runError}</p>}
          </form>

          <OnlineBackupPanel data={data} />

          <UploadSection
            onUpload={(f) => uploadMut.mutateAsync(f)}
            pending={uploadMut.isPending}
          />

          <section>
            <h3 className="font-medium mb-2 text-sm">
              Stored backups ({data.items.length})
            </h3>
            {data.items.length === 0 ? (
              <p className="text-sm text-slate-500 italic">
                No backups yet. Run one now or enable the schedule above.
              </p>
            ) : (
              <ul className="divide-y divide-slate-200 dark:divide-slate-700 border border-border rounded">
                {data.items.map((b) => (
                  <BackupRow
                    key={b.filename}
                    backup={b}
                    onDelete={() => {
                      if (window.confirm(`Delete ${b.filename}?`)) {
                        deleteMut.mutate(b.filename);
                      }
                    }}
                    onRestore={() => {
                      const confirmText =
                        'RESTORE this dump? This will REPLACE all data in the live database.\n\n' +
                        `File: ${b.filename}\n\n` +
                        'Type RESTORE to confirm:';
                      const answer = window.prompt(confirmText);
                      if (answer === 'RESTORE') {
                        restoreMut.mutate(b.filename);
                      }
                    }}
                    disabled={deleteMut.isPending || restoreMut.isPending}
                  />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </section>
  );
}

function BackupRow({
  backup,
  onDelete,
  onRestore,
  disabled,
}: {
  backup: BackupFile;
  onDelete: () => void;
  onRestore: () => void;
  disabled: boolean;
}): JSX.Element {
  const [downloading, setDownloading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleDownload(): Promise<void> {
    setDownloading(true);
    setErr(null);
    try {
      await downloadBackup(backup.filename);
    } catch (e) {
      setErr(errorMessage(e, 'Download failed'));
    } finally {
      setDownloading(false);
    }
  }

  return (
    <li className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
      <div className="flex-1 min-w-0">
        <div className="font-mono text-xs truncate">{backup.filename}</div>
        <div className="text-[11px] text-text-muted">
          {new Date(backup.createdAt).toLocaleString()} · {formatBytes(backup.sizeBytes)}
        </div>
        {err && <div role="alert" className="text-[11px] text-danger mt-1">{err}</div>}
      </div>
      <button
        type="button"
        onClick={handleDownload}
        disabled={downloading}
        className="text-xs rounded border border-border px-2 py-1 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-50"
      >
        {downloading ? 'Downloading…' : 'Download'}
      </button>
      <button
        type="button"
        onClick={onRestore}
        disabled={disabled}
        className="text-xs rounded border border-amber-400 dark:border-amber-500 text-warning px-2 py-1 hover:bg-amber-50 dark:hover:bg-amber-900/30 disabled:opacity-50"
      >
        Restore
      </button>
      <button
        type="button"
        onClick={onDelete}
        disabled={disabled}
        className="text-xs rounded border border-red-300 dark:border-red-500 text-danger px-2 py-1 hover:bg-red-50 dark:hover:bg-red-900/30 disabled:opacity-50"
      >
        Delete
      </button>
    </li>
  );
}

function UploadSection({
  onUpload,
  pending,
}: {
  onUpload: (file: File) => Promise<unknown>;
  pending: boolean;
}): JSX.Element {
  const [file, setFile] = useState<File | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!file) return;
    setErr(null);
    setOk(null);
    try {
      await onUpload(file);
      setOk(`Uploaded ${file.name}`);
      setFile(null);
      // Reset the file input.
      const input = (e.currentTarget as HTMLFormElement).querySelector(
        'input[type=file]',
      ) as HTMLInputElement | null;
      if (input) input.value = '';
    } catch (e2) {
      setErr(errorMessage(e2, 'Upload failed'));
    }
  }

  return (
    <form
      onSubmit={submit}
      className="border border-border rounded p-4 space-y-3"
    >
      <h3 className="font-medium text-sm">Upload a backup</h3>
      <p className="text-xs text-text-muted">
        Drop in a <code>.dump</code> file produced by <code>pg_dump --format=custom</code>
        {' '}— typically a download from another TaskHub instance. The file is stored
        alongside scheduler-written dumps and can be restored from the list below.
      </p>
      <input
        type="file"
        accept=".dump,application/octet-stream"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        className="block text-sm"
      />
      {err && <p role="alert" className="text-xs text-danger">{err}</p>}
      {ok && <p className="text-xs text-success">{ok}</p>}
      <button
        type="submit"
        disabled={pending || !file}
        className="bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 rounded px-3 py-1 text-sm font-medium disabled:opacity-50"
      >
        {pending ? 'Uploading…' : 'Upload'}
      </button>
    </form>
  );
}

// v2.5.36: online backup (Kopia → Google Drive) config panel. Admin sets the
// destination folder + schedule + retention here; the encryption password and
// Google service-account stay server-side secrets (see scripts/README.md →
// "Kopia + Google Drive"). Status is a best-effort reachability readout.
function OnlineBackupPanel({ data }: { data: BackupsPageData }): JSX.Element {
  const qc = useQueryClient();
  const o = data.online;
  const st = data.onlineStatus;

  const [enabled, setEnabled] = useState(o.enabled);
  const [folderId, setFolderId] = useState(o.folderId);
  const [intervalHours, setIntervalHours] = useState(o.intervalHours);
  const [keepDaily, setKeepDaily] = useState(o.keepDaily);
  const [keepWeekly, setKeepWeekly] = useState(o.keepWeekly);
  const [keepMonthly, setKeepMonthly] = useState(o.keepMonthly);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  useEffect(() => {
    setEnabled(o.enabled);
    setFolderId(o.folderId);
    setIntervalHours(o.intervalHours);
    setKeepDaily(o.keepDaily);
    setKeepWeekly(o.keepWeekly);
    setKeepMonthly(o.keepMonthly);
  }, [o]);

  const saveMut = useMutation({
    mutationFn: () =>
      updateOnlineBackupConfig({
        enabled,
        folderId: folderId.trim(),
        intervalHours,
        keepDaily,
        keepWeekly,
        keepMonthly,
      }),
    onSuccess: () => {
      setErr(null);
      setOk('Saved. Re-run scripts/kopia-setup.sh on the server to apply the new policy.');
      qc.invalidateQueries({ queryKey: ['backups'] });
    },
    onError: (e) => {
      setOk(null);
      setErr(errorMessage(e, 'Could not save'));
    },
  });

  // Status badge colour.
  const badge = st.reachable
    ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200'
    : st.configured
      ? 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200'
      : 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300';
  const badgeText = st.reachable ? 'Connected' : st.serverConfigured ? 'Not reachable' : 'Not set up';

  return (
    <section className="border border-border rounded p-4 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium text-sm">Online backup — Kopia → Google Drive</h3>
        <span className={`text-[11px] rounded-full px-2 py-0.5 ${badge}`}>{badgeText}</span>
      </div>

      <p className="text-xs text-text-muted">
        Encrypted, versioned, offsite backups of your dumps to Google Drive, with a
        web UI at <code>:51515</code>. The repository password and Google
        service-account are configured once on the server (see{' '}
        <code>scripts/README.md → "Kopia + Google Drive"</code>); here you set the
        destination folder, schedule, and retention.
      </p>
      {st.detail && <p className="text-[11px] text-text-muted">Status: {st.detail}</p>}

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <span className="font-medium">Enable online backup</span>
      </label>

      <label className="block text-sm">
        <span className="block font-medium mb-1">Google Drive folder ID</span>
        <input
          type="text"
          dir="ltr"
          value={folderId}
          onChange={(e) => setFolderId(e.target.value)}
          placeholder="1A2b3C…"
          className="rounded border-border px-2 py-1 border w-full max-w-md bg-surface font-mono text-xs"
        />
        <span className="block text-[11px] text-text-muted mt-1">
          The folder shared with the Kopia service account (copy it from the folder's URL).
        </span>
      </label>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <label className="block text-sm">
          <span className="block font-medium mb-1">Every (hours)</span>
          <input type="number" min={1} max={24 * 30} value={intervalHours}
            onChange={(e) => setIntervalHours(Number(e.target.value))}
            className="rounded border-border px-2 py-1 border w-full bg-surface" />
        </label>
        <label className="block text-sm">
          <span className="block font-medium mb-1">Keep daily</span>
          <input type="number" min={0} max={365} value={keepDaily}
            onChange={(e) => setKeepDaily(Number(e.target.value))}
            className="rounded border-border px-2 py-1 border w-full bg-surface" />
        </label>
        <label className="block text-sm">
          <span className="block font-medium mb-1">Keep weekly</span>
          <input type="number" min={0} max={520} value={keepWeekly}
            onChange={(e) => setKeepWeekly(Number(e.target.value))}
            className="rounded border-border px-2 py-1 border w-full bg-surface" />
        </label>
        <label className="block text-sm">
          <span className="block font-medium mb-1">Keep monthly</span>
          <input type="number" min={0} max={240} value={keepMonthly}
            onChange={(e) => setKeepMonthly(Number(e.target.value))}
            className="rounded border-border px-2 py-1 border w-full bg-surface" />
        </label>
      </div>

      {err && <p role="alert" className="text-xs text-danger">{err}</p>}
      {ok && <p className="text-xs text-success">{ok}</p>}

      <button
        type="button"
        onClick={() => saveMut.mutate()}
        disabled={saveMut.isPending}
        className="bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 rounded px-3 py-1 text-sm font-medium disabled:opacity-50"
      >
        {saveMut.isPending ? 'Saving…' : 'Save online backup settings'}
      </button>
    </section>
  );
}

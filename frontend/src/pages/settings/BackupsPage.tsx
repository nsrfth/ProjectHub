import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { Navigate } from 'react-router-dom';
import { useAuth } from '@/features/auth/AuthContext';
import {
  deleteBackup,
  downloadBackup,
  fetchBackups,
  runBackupNow,
  updateBackupConfig,
  type BackupFile,
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
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Schedule periodic Postgres dumps. Files are stored on the backend's
          backups volume (<code>/app/backups</code>) and pruned by the
          retention policy below.
        </p>
      </header>

      {isLoading && <p className="text-sm text-slate-400">Loading…</p>}
      {error && <p className="text-sm text-red-600">{errorMessage(error, 'Could not load backups')}</p>}

      {data && (
        <>
          <form
            onSubmit={submit}
            className="border border-slate-200 dark:border-slate-700 rounded p-4 space-y-4"
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
                  className="rounded border-slate-300 dark:border-slate-600 px-2 py-1 border w-32 bg-white dark:bg-slate-700"
                />
                <span className="block text-[11px] text-slate-500 dark:text-slate-400 mt-1">
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
                  className="rounded border-slate-300 dark:border-slate-600 px-2 py-1 border w-32 bg-white dark:bg-slate-700"
                />
                <span className="block text-[11px] text-slate-500 dark:text-slate-400 mt-1">
                  Older dumps are deleted after each successful run. Range 1..365.
                </span>
              </label>
            </div>

            {configError && <p className="text-xs text-red-600">{configError}</p>}

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
                className="rounded border border-slate-300 dark:border-slate-600 px-3 py-1 text-sm font-medium hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-50"
              >
                {runMut.isPending ? 'Running…' : 'Run backup now'}
              </button>
              <div className="text-xs text-slate-500 dark:text-slate-400">
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
              <p className="text-xs text-emerald-700 dark:text-emerald-400">{runOk}</p>
            )}
            {runError && <p className="text-xs text-red-600">{runError}</p>}
          </form>

          <section>
            <h3 className="font-medium mb-2 text-sm">
              Stored backups ({data.items.length})
            </h3>
            {data.items.length === 0 ? (
              <p className="text-sm text-slate-500 italic">
                No backups yet. Run one now or enable the schedule above.
              </p>
            ) : (
              <ul className="divide-y divide-slate-200 dark:divide-slate-700 border border-slate-200 dark:border-slate-700 rounded">
                {data.items.map((b) => (
                  <BackupRow
                    key={b.filename}
                    backup={b}
                    onDelete={() => {
                      if (window.confirm(`Delete ${b.filename}?`)) {
                        deleteMut.mutate(b.filename);
                      }
                    }}
                    disabled={deleteMut.isPending}
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
  disabled,
}: {
  backup: BackupFile;
  onDelete: () => void;
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
        <div className="text-[11px] text-slate-500 dark:text-slate-400">
          {new Date(backup.createdAt).toLocaleString()} · {formatBytes(backup.sizeBytes)}
        </div>
        {err && <div className="text-[11px] text-red-600 mt-1">{err}</div>}
      </div>
      <button
        type="button"
        onClick={handleDownload}
        disabled={downloading}
        className="text-xs rounded border border-slate-300 dark:border-slate-600 px-2 py-1 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-50"
      >
        {downloading ? 'Downloading…' : 'Download'}
      </button>
      <button
        type="button"
        onClick={onDelete}
        disabled={disabled}
        className="text-xs rounded border border-red-300 text-red-700 dark:border-red-500 dark:text-red-300 px-2 py-1 hover:bg-red-50 dark:hover:bg-red-900/30 disabled:opacity-50"
      >
        Delete
      </button>
    </li>
  );
}

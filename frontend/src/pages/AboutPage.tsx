import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import axios from 'axios';
import { fetchSystemInfo, fetchUpdateCheck, triggerUpgrade } from '@/features/system/api';
import { useAuth } from '@/features/auth/AuthContext';
import { useT } from '@/lib/i18n';
import { shouldShowHttpsPwaWarning } from '@/pages/aboutHttpsWarning';

// "About" view — quick reference to the running instance: version, build
// info, environment, headline counts, license, and links to deeper docs.
// Public-ish (anyone authenticated can see it; the backend endpoint is
// auth-less so even the login page could pull from it if needed).

export default function AboutPage(): JSX.Element {
  const { user } = useAuth();
  const t = useT();
  const { data, isLoading, error } = useQuery({
    queryKey: ['system', 'info'],
    queryFn: fetchSystemInfo,
    staleTime: 5 * 60_000,
  });

  // Admin-only opt-in update check. We gate the fetch on globalRole so
  // non-admins never hit the 403; the endpoint is also no-op (enabled:false)
  // when the operator hasn't set UPDATE_CHECK_ENABLED, so we still hide the
  // badge in that case.
  const isAdmin = user?.globalRole === 'ADMIN';
  const showHttpsPwaWarning = shouldShowHttpsPwaWarning(
    isAdmin,
    typeof window !== 'undefined' ? window.isSecureContext : true,
  );
  const { data: update } = useQuery({
    queryKey: ['system', 'update-check'],
    queryFn: fetchUpdateCheck,
    enabled: isAdmin,
    // Backend caches for 6h; the SPA caches for 5 min so refreshing the page
    // doesn't fire a new request, but switching tabs after a while does.
    staleTime: 5 * 60_000,
    // The badge is purely informational — a flaky network shouldn't surface
    // a red error in the UI.
    retry: false,
  });

  return (
    <div className="p-8 max-w-2xl mx-auto">
      <h1 className="text-2xl font-semibold mb-6">About TaskHub</h1>

      <section className="bg-white shadow rounded p-6 space-y-4">
        {showHttpsPwaWarning && (
          <div
            role="note"
            className="rounded-md bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200 p-4 text-sm space-y-1"
          >
            <p className="font-medium">{t('about.https.warningTitle')}</p>
            <p>{t('about.https.warningBody')}</p>
          </div>
        )}

        {isLoading && <p className="text-sm text-slate-500">Loading…</p>}
        {error && (
          <p className="text-sm text-red-600">
            Could not reach the server.
          </p>
        )}

        {data && (
          <>
            <Field label="Application">{data.name}</Field>
            <Field label="Version">
              <span className="inline-flex items-center gap-2 flex-wrap">
                <code>{data.version}</code>
                {/* Admin-only "update available" badge. Only renders when the
                    operator enabled UPDATE_CHECK_ENABLED AND GitHub returned
                    a newer tag than what's running. Quiet by design — a small
                    inline pill, not a banner. */}
                {isAdmin && update?.enabled && update.updateAvailable && update.latestVersion && (
                  <a
                    href={update.releaseUrl ?? '#'}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 rounded-full bg-emerald-100 text-emerald-800 px-2 py-0.5 text-xs hover:bg-emerald-200"
                    title={
                      update.publishedAt
                        ? `Released ${new Date(update.publishedAt).toLocaleDateString()}`
                        : 'View release on GitHub'
                    }
                  >
                    ↑ Update available: {update.latestVersion}
                  </a>
                )}
                {/* v1.22: Admin-only "Run upgrade now" button. Visible only
                    when there's actually an update to run. Goes through the
                    privileged updater sidecar; the operator must opt in by
                    configuring UPDATER_URL + UPDATER_TOKEN AND bringing the
                    `upgrade` compose profile up. */}
                {isAdmin && update?.enabled && update.updateAvailable && (
                  <UpgradeButton latestVersion={update.latestVersion ?? 'latest'} />
                )}
              </span>
            </Field>
            {data.buildTime && (
              <Field label="Built">
                <time dateTime={data.buildTime}>{data.buildTime}</time>
              </Field>
            )}
            <Field label="Environment"><code>{data.nodeEnv}</code></Field>
            <Field label="Off-days">
              {data.calendarWeekend.length === 0
                ? 'None configured (every day is a work day)'
                : data.calendarWeekend
                    .map((d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d])
                    .join(' · ')}
            </Field>
            <Field label="Counts">
              {data.counts.users} user{data.counts.users === 1 ? '' : 's'} ·{' '}
              {data.counts.teams} team{data.counts.teams === 1 ? '' : 's'} ·{' '}
              {data.counts.tasks} task{data.counts.tasks === 1 ? '' : 's'}
            </Field>
          </>
        )}

        <hr className="my-2" />

        <Field label="License">
          MIT — Copyright © 2026 TaskHub contributors. See{' '}
          <a href="/LICENSE" target="_blank" rel="noopener noreferrer" className="underline">
            LICENSE
          </a>{' '}
          for the full text.
        </Field>

        <Field label="Author">
          Naser Fathi ·{' '}
          <a
            href="https://www.linkedin.com/in/naser-fathi/"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            LinkedIn
          </a>
        </Field>

        <Field label="Documentation">
          <Link to="/help" className="underline">User manual</Link>{' '}
          ·{' '}
          <a href="/CHANGELOG.md" target="_blank" rel="noopener noreferrer" className="underline">
            CHANGELOG
          </a>
        </Field>

        <Field label="Tech">
          React + Vite (frontend); Fastify + Prisma + Postgres + Redis (backend);
          Caddy reverse proxy; deployed via Docker Compose.
        </Field>

        <p className="text-xs text-slate-400 mt-4">
          Need help? Open the user manual via the 📖 button (top-right),
          or contact your TaskHub administrator.
        </p>
      </section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-3 text-sm">
      <span className="text-xs uppercase tracking-wide text-slate-500 pt-0.5">{label}</span>
      <span className="text-slate-800">{children}</span>
    </div>
  );
}

// v1.22: "Run upgrade now" button + the mid-upgrade overlay. POSTs to the
// admin endpoint, then polls /health every 5 s; auto-reloads the SPA when
// the backend comes back. If UPDATER_URL isn't configured, the endpoint
// returns 503 with a friendly message that we surface inline.
function UpgradeButton({ latestVersion }: { latestVersion: string }): JSX.Element {
  const [phase, setPhase] = useState<'idle' | 'starting' | 'waiting' | 'failed'>('idle');
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const startMut = useMutation({
    mutationFn: () => triggerUpgrade(),
    onMutate: () => {
      setErrMsg(null);
      setPhase('starting');
    },
    onSuccess: () => {
      setPhase('waiting');
      // Poll /api/health every 5 s. Reload the SPA the first time it answers
      // — that's the cheapest "the new backend is alive" signal. We don't
      // try to compare versions; reload is safe even if the upgrade was a
      // no-op (e.g. operator was already on the latest tag).
      const startedAt = Date.now();
      const id = setInterval(async () => {
        try {
          const res = await fetch('/api/health', { cache: 'no-store' });
          if (res.ok) {
            clearInterval(id);
            window.location.reload();
          }
        } catch {
          /* network blip while the backend restarts — keep polling */
        }
        // Hard timeout at 5 minutes — past that, something's wrong and the
        // operator should look at `docker compose logs`.
        if (Date.now() - startedAt > 5 * 60_000) {
          clearInterval(id);
          setPhase('failed');
          setErrMsg('Backend did not come back within 5 minutes. Check `docker compose logs`.');
        }
      }, 5_000);
    },
    onError: (err) => {
      setPhase('failed');
      if (axios.isAxiosError(err)) {
        setErrMsg(err.response?.data?.error?.message ?? 'Upgrade request failed');
      } else {
        setErrMsg('Upgrade request failed');
      }
    },
  });

  if (phase === 'waiting') {
    return (
      <span
        role="status"
        className="inline-flex items-center gap-1 rounded-full bg-amber-100 text-amber-800 px-2 py-0.5 text-xs"
        title="Polling /api/health every 5 s. The SPA will reload automatically when the new backend is up."
      >
        Upgrading… page will reload when done
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={() => {
          if (
            window.confirm(
              `Run in-app upgrade to ${latestVersion}? The backend will restart and this page will reload automatically when it's back. Make sure you've taken a Postgres backup first (see UPGRADE.md).`,
            )
          ) {
            startMut.mutate();
          }
        }}
        disabled={phase === 'starting'}
        className="rounded-full bg-slate-900 text-white px-2 py-0.5 text-xs hover:bg-slate-700 disabled:opacity-50"
      >
        {phase === 'starting' ? 'Starting…' : 'Run upgrade now'}
      </button>
      {errMsg && (
        <span className="text-xs text-red-600 dark:text-red-400" title={errMsg}>
          {errMsg}
        </span>
      )}
    </span>
  );
}

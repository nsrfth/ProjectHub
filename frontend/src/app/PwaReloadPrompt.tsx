import { useRegisterSW } from 'virtual:pwa-register/react';
import { useT } from '@/lib/i18n';

// v2.5.55: controlled PWA update UX. With `registerType: 'prompt'`, a freshly
// deployed service worker installs and WAITS instead of silently taking over;
// `needRefresh` flips true and we surface a toast. Clicking Refresh calls
// `updateServiceWorker(true)` → the waiting SW skip-waits, claims the page, and
// reloads it onto the new bundle. This replaces the old silent `autoUpdate`
// behaviour where an already-open tab kept running the stale precached bundle
// against a newer backend — which rendered a blank dashboard / empty teams list
// (see the note in docker/Caddyfile about the same failure mode).
export default function PwaReloadPrompt() {
  const t = useT();
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  if (!needRefresh) return null;

  return (
    <div
      role="alert"
      className="fixed inset-x-0 bottom-4 z-[1000] mx-auto flex w-fit max-w-[92vw] items-center gap-3 rounded-lg bg-indigo-600 px-4 py-3 text-sm text-white shadow-lg"
    >
      <span>{t('pwa.newVersion')}</span>
      <button
        type="button"
        onClick={() => void updateServiceWorker(true)}
        className="rounded-md bg-white/20 px-3 py-1 font-medium transition-colors hover:bg-white/30"
      >
        {t('pwa.refresh')}
      </button>
      <button
        type="button"
        aria-label={t('pwa.dismiss')}
        title={t('pwa.dismiss')}
        onClick={() => setNeedRefresh(false)}
        className="rounded-md px-2 py-1 text-white/80 transition-colors hover:text-white"
      >
        ✕
      </button>
    </div>
  );
}

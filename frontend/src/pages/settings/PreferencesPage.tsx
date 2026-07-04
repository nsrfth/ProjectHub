import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/features/auth/AuthContext';
import { updatePreferences } from '@/features/auth/api';
import { setThemePreference, type ThemePreference } from '@/lib/theme';
import ThemePicker from '@/features/settings/ThemePicker';
import { Radio, errorMessage } from '@/features/settings/prefFormHelpers';
import { setLanguage, useT, type Language } from '@/lib/i18n';
import { api } from '@/lib/api';

// v1.13: per-user display preferences — theme (LIGHT/DARK) + UI language
// (EN/FA). All calendar / date-time preferences moved to the dedicated
// "Date & time" settings page in v2.6 (see DateTimeSettingsPage).
//
// Save flow per pref: PATCH server → mirror to lib/* module state →
// localStorage → reload the window so every module-level reader (theme class,
// RTL direction, translations) gets the new value in one paint.

export default function PreferencesPage(): JSX.Element {
  const { user, patchUser } = useAuth();
  const t = useT();

  const initialTheme: ThemePreference = (user?.themePreference ?? 'LIGHT') as ThemePreference;
  const initialLanguage: Language = (user?.languagePreference ?? 'EN') as Language;

  const [theme, setLocalTheme] = useState<ThemePreference>(initialTheme);
  const [language, setLocalLanguage] = useState<Language>(initialLanguage);
  const [error, setError] = useState<string | null>(null);

  const saveMut = useMutation({
    mutationFn: () => updatePreferences({ theme, language }),
    onSuccess: (res) => {
      patchUser({
        themePreference: res.theme,
        languagePreference: res.language,
      });
      const themeChanged = setThemePreference(res.theme);
      const langChanged = setLanguage(res.language);
      if (themeChanged || langChanged) {
        window.location.reload();
      }
    },
    onError: (err) => setError(errorMessage(err, 'Could not save preferences')),
  });

  const dirty = theme !== initialTheme || language !== initialLanguage;

  function submit(e: FormEvent): void {
    e.preventDefault();
    saveMut.mutate();
  }

  return (
    <section className="space-y-6">
      <header>
        <h2 className="text-lg font-semibold mb-1">{t('preferences.title')}</h2>
        <p className="text-sm text-text-muted">
          {t('preferences.subtitle')}
        </p>
      </header>

      <form onSubmit={submit} className="border border-border rounded p-4 space-y-5 bg-surface">
        {/* Theme */}
        <fieldset>
          <legend className="font-medium">{t('preferences.theme.title')}</legend>
          <div className="mt-2">
            <ThemePicker value={theme} onChange={setLocalTheme} />
          </div>
        </fieldset>

        {/* Language */}
        <fieldset className="border-t border-border pt-4">
          <legend className="font-medium">{t('preferences.language')}</legend>
          <div className="space-y-2 mt-2">
            <Radio
              name="language"
              value="EN"
              checked={language === 'EN'}
              onChange={() => setLocalLanguage('EN')}
              label={t('preferences.language.en')}
            />
            <Radio
              name="language"
              value="FA"
              checked={language === 'FA'}
              onChange={() => setLocalLanguage('FA')}
              label={t('preferences.language.fa')}
            />
          </div>
        </fieldset>

        {error && <p role="alert" className="text-xs text-danger">{error}</p>}

        <div className="flex gap-2 pt-1">
          <button
            type="submit"
            disabled={saveMut.isPending || !dirty}
            className="bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 rounded px-3 py-1 text-sm font-medium disabled:opacity-50"
          >
            {saveMut.isPending ? t('preferences.saving') : t('preferences.save')}
          </button>
          {dirty && (
            <p className="text-xs text-text-muted self-center">
              {t('preferences.willReload')}
            </p>
          )}
        </div>
      </form>

      {/* v1.29: admin-only dependency enforcement setting. Instance-wide. */}
      {user?.globalRole === 'ADMIN' && <DependencyEnforcementSection />}
    </section>
  );
}

function DependencyEnforcementSection(): JSX.Element {
  const qc = useQueryClient();
  const { data: row, isLoading } = useQuery({
    queryKey: ['instance-setting', 'tasks.dependencyEnforcement'],
    queryFn: async () => {
      // Falls back to "off" when the row doesn't exist yet — the API
      // returns 404 for an unset key. Treat that as the default.
      try {
        const r = await api.get<{ value: 'off' | 'warn' | 'block' }>(
          '/settings/instance/tasks.dependencyEnforcement',
        );
        return r.data.value ?? 'off';
      } catch {
        return 'off' as const;
      }
    },
    staleTime: 5 * 60_000,
  });
  const [draft, setDraft] = useState<'off' | 'warn' | 'block'>(row ?? 'off');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (row) setDraft(row);
  }, [row]);

  const saveMut = useMutation({
    mutationFn: async () => {
      await api.put('/settings/instance/tasks.dependencyEnforcement', { value: draft });
      return draft;
    },
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ['instance-setting', 'tasks.dependencyEnforcement'] });
    },
    onError: (err) => setError(errorMessage(err, 'Could not save')),
  });

  const dirty = row !== undefined && draft !== row;

  return (
    <form
      onSubmit={(e: FormEvent) => { e.preventDefault(); saveMut.mutate(); }}
      className="border border-border rounded p-4 space-y-3"
    >
      <h3 className="font-medium">Task dependencies — enforcement (admin · instance-wide)</h3>
      <p className="text-sm text-text-muted">
        Controls how strictly TaskHub treats <code>FINISH_TO_START</code> dependency edges
        when a task changes status. The dependency UI itself (add / remove edges, see who's
        blocking whom) is always available regardless of this setting.
      </p>
      {isLoading && <p className="text-xs text-slate-400">Loading…</p>}
      <div className="space-y-2">
        <Radio
          name="dep-enforcement"
          value="off"
          checked={draft === 'off'}
          onChange={() => setDraft('off')}
          label={<><strong>Off</strong> — edges are informational only.</>}
        />
        <Radio
          name="dep-enforcement"
          value="warn"
          checked={draft === 'warn'}
          onChange={() => setDraft('warn')}
          label={<><strong>Warn</strong> — UI shows a notice but never blocks the status change.</>}
        />
        <Radio
          name="dep-enforcement"
          value="block"
          checked={draft === 'block'}
          onChange={() => setDraft('block')}
          label={<><strong>Block</strong> — a task can't move to <em>In progress</em> or <em>Done</em> while it has incomplete blockers.</>}
        />
      </div>
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          disabled={saveMut.isPending || !dirty}
          className="bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 rounded px-3 py-1 text-sm font-medium disabled:opacity-50"
        >
          {saveMut.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}

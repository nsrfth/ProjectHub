import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { useAuth } from '@/features/auth/AuthContext';
import { updatePreferences } from '@/features/auth/api';
import { setCalendar, setWeekendDays, type Calendar } from '@/lib/calendar';
import { setTheme, type Theme } from '@/lib/theme';
import { setLanguage, useT, type Language } from '@/lib/i18n';
import { fetchSystemInfo } from '@/features/system/api';
import { api } from '@/lib/api';

// v1.10/v1.13: per-user display preferences. Calendar (SHAMSI/GREGORIAN),
// theme (LIGHT/DARK), language (EN/FA). Plus admin-only Workweek section
// from v1.11.
//
// Save flow per pref: PATCH server → mirror to lib/* module state →
// localStorage → reload the window so every module-level reader (date
// formatters, picker, theme class, RTL direction, translations) gets the
// new value in one paint.

function errorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const msg = err.response?.data?.error?.message;
    if (typeof msg === 'string' && msg.length) return msg;
  }
  return fallback;
}

export default function PreferencesPage(): JSX.Element {
  const { user, patchUser } = useAuth();
  const t = useT();

  const initialCalendar: Calendar = (user?.calendarPreference ?? 'SHAMSI') as Calendar;
  const initialTheme: Theme = (user?.themePreference ?? 'LIGHT') as Theme;
  const initialLanguage: Language = (user?.languagePreference ?? 'EN') as Language;

  const [calendar, setLocalCalendar] = useState<Calendar>(initialCalendar);
  const [theme, setLocalTheme] = useState<Theme>(initialTheme);
  const [language, setLocalLanguage] = useState<Language>(initialLanguage);
  const [error, setError] = useState<string | null>(null);

  const saveMut = useMutation({
    mutationFn: () => updatePreferences({ calendar, theme, language }),
    onSuccess: (res) => {
      patchUser({
        calendarPreference: res.calendar,
        themePreference: res.theme,
        languagePreference: res.language,
      });
      const calChanged = setCalendar(res.calendar);
      const themeChanged = setTheme(res.theme);
      const langChanged = setLanguage(res.language);
      if (calChanged || themeChanged || langChanged) {
        window.location.reload();
      }
    },
    onError: (err) => setError(errorMessage(err, 'Could not save preferences')),
  });

  const dirty =
    calendar !== initialCalendar ||
    theme !== initialTheme ||
    language !== initialLanguage;

  function submit(e: FormEvent): void {
    e.preventDefault();
    saveMut.mutate();
  }

  return (
    <section className="space-y-6">
      <header>
        <h2 className="text-lg font-semibold mb-1">{t('preferences.title')}</h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {t('preferences.subtitle')}
        </p>
      </header>

      <form onSubmit={submit} className="border border-slate-200 dark:border-slate-700 rounded p-4 space-y-5">
        {/* Calendar */}
        <fieldset>
          <legend className="font-medium">{t('preferences.calendar')}</legend>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1 mb-2">
            {t('preferences.calendarSubtitle')}
          </p>
          <div className="space-y-2">
            <Radio
              name="calendar"
              value="SHAMSI"
              checked={calendar === 'SHAMSI'}
              onChange={() => setLocalCalendar('SHAMSI')}
              label={<><span className="font-medium">{t('preferences.calendar.shamsi')}</span> — <span dir="rtl">۱ خرداد ۱۴۰۵</span></>}
            />
            <Radio
              name="calendar"
              value="GREGORIAN"
              checked={calendar === 'GREGORIAN'}
              onChange={() => setLocalCalendar('GREGORIAN')}
              label={<><span className="font-medium">{t('preferences.calendar.gregorian')}</span> — <code>2026-05-22</code></>}
            />
          </div>
        </fieldset>

        {/* Theme */}
        <fieldset className="border-t border-slate-200 dark:border-slate-700 pt-4">
          <legend className="font-medium">{t('preferences.theme')}</legend>
          <div className="space-y-2 mt-2">
            <Radio
              name="theme"
              value="LIGHT"
              checked={theme === 'LIGHT'}
              onChange={() => setLocalTheme('LIGHT')}
              label={t('preferences.theme.light')}
            />
            <Radio
              name="theme"
              value="DARK"
              checked={theme === 'DARK'}
              onChange={() => setLocalTheme('DARK')}
              label={t('preferences.theme.dark')}
            />
          </div>
        </fieldset>

        {/* Language */}
        <fieldset className="border-t border-slate-200 dark:border-slate-700 pt-4">
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

        {error && <p className="text-xs text-red-600">{error}</p>}

        <div className="flex gap-2 pt-1">
          <button
            type="submit"
            disabled={saveMut.isPending || !dirty}
            className="bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 rounded px-3 py-1 text-sm font-medium disabled:opacity-50"
          >
            {saveMut.isPending ? t('preferences.saving') : t('preferences.save')}
          </button>
          {dirty && (
            <p className="text-xs text-slate-500 dark:text-slate-400 self-center">
              {t('preferences.willReload')}
            </p>
          )}
        </div>
      </form>

      {/* Admin-only Workweek section — instance-wide. Untouched from v1.11. */}
      {user?.globalRole === 'ADMIN' && <WorkweekSection />}
    </section>
  );
}

function Radio({
  name, value, checked, onChange, label,
}: {
  name: string; value: string; checked: boolean; onChange: () => void; label: React.ReactNode;
}): JSX.Element {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input type="radio" name={name} value={value} checked={checked} onChange={onChange} className="mt-1" />
      <span className="text-slate-700 dark:text-slate-200">{label}</span>
    </label>
  );
}

// ── Admin-only Workweek section (instance-wide) ─────────────────────────
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function WorkweekSection(): JSX.Element {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['system', 'info'],
    queryFn: fetchSystemInfo,
    staleTime: 5 * 60_000,
  });

  const [draft, setDraft] = useState<number[]>(() => data?.calendarWeekend ?? [0, 6]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (data) setDraft(data.calendarWeekend);
  }, [data]);

  const saveMut = useMutation({
    mutationFn: async () => {
      await api.put('/settings/instance/calendar.weekend', { value: draft });
      return draft;
    },
    onSuccess: (next) => {
      setError(null);
      setWeekendDays(next);
      qc.invalidateQueries({ queryKey: ['system', 'info'] });
      window.location.reload();
    },
    onError: (err) => {
      if (axios.isAxiosError(err)) {
        const msg = err.response?.data?.error?.message;
        setError(typeof msg === 'string' ? msg : 'Could not save');
      } else {
        setError('Could not save');
      }
    },
  });

  function toggle(day: number): void {
    setDraft((prev) => prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort((a, b) => a - b));
  }

  const initial = data?.calendarWeekend ?? [0, 6];
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);

  return (
    <form
      onSubmit={(e: FormEvent) => { e.preventDefault(); saveMut.mutate(); }}
      className="border border-slate-200 dark:border-slate-700 rounded p-4 space-y-3"
    >
      <h3 className="font-medium">Workweek (admin · instance-wide)</h3>
      <p className="text-sm text-slate-600 dark:text-slate-400">
        Pick the days the instance treats as off-days. They appear in
        <span className="text-red-600 font-medium"> red </span>
        on every date picker.
      </p>

      {isLoading && <p className="text-xs text-slate-400">Loading…</p>}

      <div className="flex flex-wrap gap-2">
        <PresetButton
          label="Saturday + Sunday off (Western)"
          active={JSON.stringify(draft) === JSON.stringify([0, 6])}
          onClick={() => setDraft([0, 6])}
        />
        <PresetButton
          label="Thursday + Friday off (Iranian / Gulf)"
          active={JSON.stringify(draft) === JSON.stringify([4, 5])}
          onClick={() => setDraft([4, 5])}
        />
      </div>

      <details className="text-sm">
        <summary className="cursor-pointer text-slate-600 dark:text-slate-400">
          Or pick custom days
        </summary>
        <fieldset className="flex flex-wrap gap-3 text-sm mt-2 pl-3">
          {WEEKDAY_LABELS.map((label, idx) => (
            <label key={idx} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={draft.includes(idx)}
                onChange={() => toggle(idx)}
              />
              <span className={draft.includes(idx) ? 'text-red-600 font-medium' : ''}>
                {label}
              </span>
            </label>
          ))}
        </fieldset>
      </details>

      {error && <p className="text-xs text-red-600">{error}</p>}

      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          disabled={saveMut.isPending || !dirty}
          className="bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 rounded px-3 py-1 text-sm font-medium disabled:opacity-50"
        >
          {saveMut.isPending ? 'Saving…' : 'Save workweek (reloads page)'}
        </button>
      </div>
    </form>
  );
}

function PresetButton({
  label, active, onClick,
}: { label: string; active: boolean; onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'text-sm rounded border px-3 py-1',
        active
          ? 'bg-slate-900 text-white border-slate-900 dark:bg-slate-100 dark:text-slate-900'
          : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100 dark:bg-slate-800 dark:text-slate-200 dark:border-slate-600 dark:hover:bg-slate-700',
      ].join(' ')}
    >
      {label}
    </button>
  );
}

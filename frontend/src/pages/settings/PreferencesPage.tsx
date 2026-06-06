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

      {/* v1.18: admin-only date-edit restriction. Instance-wide. */}
      {user?.globalRole === 'ADMIN' && <DateEditRestrictionSection />}

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
      className="border border-slate-200 dark:border-slate-700 rounded p-4 space-y-3"
    >
      <h3 className="font-medium">Task dependencies — enforcement (admin · instance-wide)</h3>
      <p className="text-sm text-slate-600 dark:text-slate-400">
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
      {error && <p className="text-xs text-red-600">{error}</p>}
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

function DateEditRestrictionSection(): JSX.Element {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['system', 'info'],
    queryFn: fetchSystemInfo,
    staleTime: 5 * 60_000,
  });
  const [draft, setDraft] = useState<'open' | 'manager-only'>(() => data?.dateEditRestriction ?? 'open');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (data) setDraft(data.dateEditRestriction);
  }, [data]);

  const saveMut = useMutation({
    mutationFn: async () => {
      // The InstanceSetting endpoint takes any JSON value at the chosen key.
      await api.put('/settings/instance/tasks.dateEditRestriction', { value: draft });
      return draft;
    },
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ['system', 'info'] });
      // No reload needed — task pages re-fetch systemInfo on next mount.
    },
    onError: (err) => setError(errorMessage(err, 'Could not save')),
  });

  const dirty = data && draft !== data.dateEditRestriction;

  return (
    <form
      onSubmit={(e: FormEvent) => { e.preventDefault(); saveMut.mutate(); }}
      className="border border-slate-200 dark:border-slate-700 rounded p-4 space-y-3"
    >
      <h3 className="font-medium">Task dates — who can change them? (admin · instance-wide)</h3>
      <p className="text-sm text-slate-600 dark:text-slate-400">
        Controls who can MODIFY the due / planned / completed dates on a task.
        Adding a date when none exists is always allowed for everyone.
      </p>
      {isLoading && <p className="text-xs text-slate-400">Loading…</p>}
      <div className="space-y-2">
        <Radio
          name="date-edit-restriction"
          value="open"
          checked={draft === 'open'}
          onChange={() => setDraft('open')}
          label={<><strong>Open</strong> — anyone in the team can add, change, or clear any date.</>}
        />
        <Radio
          name="date-edit-restriction"
          value="manager-only"
          checked={draft === 'manager-only'}
          onChange={() => setDraft('manager-only')}
          label={<><strong>Manager-only</strong> — members can ADD a date when none is set, but only team MANAGERS or global ADMINS can change or clear an existing date.</>}
        />
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
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

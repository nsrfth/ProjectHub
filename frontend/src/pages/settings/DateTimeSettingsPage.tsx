import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { useAuth } from '@/features/auth/AuthContext';
import { updatePreferences } from '@/features/auth/api';
import { setCalendar, setWeekendDays, type Calendar } from '@/lib/calendar';
import TimeZonePicker from '@/features/settings/TimeZonePicker';
import HolidaysSection from '@/features/settings/HolidaysSection';
import { Radio, errorMessage, normalizeTimeZone } from '@/features/settings/prefFormHelpers';
import { useT } from '@/lib/i18n';
import {
  setDualCalendar,
  setTimeFormat,
  setTimeZone,
  type TimeFormat,
} from '@/lib/datetime';
import { fetchSystemInfo } from '@/features/system/api';
import { api } from '@/lib/api';

// v2.6: all calendar / date-time settings grouped under one Settings menu.
// The per-user display fields (calendar system, time zone, time format, dual
// calendar, reminder lead hours) plus the admin-only instance-wide calendar
// configuration (workweek, holidays, working-day scheduling, off-day reminders,
// date-edit restriction) — moved here out of Preferences.
//
// Save flow per pref: PATCH server → mirror to lib/* module state →
// localStorage → reload the window so every module-level reader (date
// formatters, picker) gets the new value in one paint.

export default function DateTimeSettingsPage(): JSX.Element {
  const { user, patchUser } = useAuth();
  const t = useT();

  const initialCalendar: Calendar = (user?.calendarPreference ?? 'SHAMSI') as Calendar;
  const initialTimeZone: string | null = normalizeTimeZone(user?.timeZone);
  const initialTimeFormat: TimeFormat = user?.timeFormat ?? 'H24';
  const initialDualCalendar = user?.dualCalendar ?? false;
  const initialReminderLeadHours = user?.reminderLeadHours ?? 24;

  const [calendar, setLocalCalendar] = useState<Calendar>(initialCalendar);
  const [timeZone, setLocalTimeZone] = useState<string | null>(initialTimeZone);
  const [timeFormat, setLocalTimeFormat] = useState<TimeFormat>(initialTimeFormat);
  const [dualCalendar, setLocalDualCalendar] = useState(initialDualCalendar);
  const [reminderLeadHours, setLocalReminderLeadHours] = useState(initialReminderLeadHours);
  const [error, setError] = useState<string | null>(null);

  const saveMut = useMutation({
    mutationFn: () =>
      updatePreferences({
        calendar,
        timeZone: normalizeTimeZone(timeZone),
        timeFormat,
        dualCalendar,
        reminderLeadHours,
      }),
    onSuccess: (res) => {
      patchUser({
        calendarPreference: res.calendar,
        timeZone: res.timeZone,
        timeFormat: res.timeFormat,
        dualCalendar: res.dualCalendar,
        reminderLeadHours: res.reminderLeadHours,
      });
      const calChanged = setCalendar(res.calendar);
      const tzChanged = setTimeZone(res.timeZone);
      const tfChanged = setTimeFormat(res.timeFormat);
      const dcChanged = setDualCalendar(res.dualCalendar);
      if (calChanged || tzChanged || tfChanged || dcChanged) {
        window.location.reload();
      }
    },
    onError: (err) => setError(errorMessage(err, 'Could not save preferences')),
  });

  const dirty =
    calendar !== initialCalendar ||
    timeZone !== initialTimeZone ||
    timeFormat !== initialTimeFormat ||
    dualCalendar !== initialDualCalendar ||
    reminderLeadHours !== initialReminderLeadHours;

  function submit(e: FormEvent): void {
    e.preventDefault();
    saveMut.mutate();
  }

  return (
    <section className="space-y-6">
      <header>
        <h2 className="text-lg font-semibold mb-1">{t('settings.dateTime.title')}</h2>
        <p className="text-sm text-text-muted">{t('settings.dateTime.subtitle')}</p>
      </header>

      <form onSubmit={submit} className="border border-border rounded p-4 space-y-5 bg-surface">
        {/* Calendar */}
        <fieldset>
          <legend className="font-medium">{t('preferences.calendar')}</legend>
          <p className="text-sm text-text-muted mt-1 mb-2">
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

        {/* Timezone */}
        <fieldset className="border-t border-border pt-4">
          <legend className="font-medium">{t('prefs.timezone')}</legend>
          <p className="text-sm text-text-muted mt-1 mb-2">
            {t('prefs.timezone.subtitle')}
          </p>
          <TimeZonePicker value={timeZone} onChange={setLocalTimeZone} />
        </fieldset>

        {/* Time format */}
        <fieldset className="border-t border-border pt-4">
          <legend className="font-medium">{t('prefs.timeFormat')}</legend>
          <div className="space-y-2 mt-2">
            <Radio
              name="timeFormat"
              value="H24"
              checked={timeFormat === 'H24'}
              onChange={() => setLocalTimeFormat('H24')}
              label={t('prefs.timeFormat.h24')}
            />
            <Radio
              name="timeFormat"
              value="H12"
              checked={timeFormat === 'H12'}
              onChange={() => setLocalTimeFormat('H12')}
              label={t('prefs.timeFormat.h12')}
            />
          </div>
        </fieldset>

        {/* Dual calendar */}
        <fieldset className="border-t border-border pt-4">
          <legend className="font-medium">{t('prefs.dualCalendar')}</legend>
          <p className="text-sm text-text-muted mt-1 mb-2">
            {t('prefs.dualCalendar.subtitle')}
          </p>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={dualCalendar}
              onChange={(e) => setLocalDualCalendar(e.target.checked)}
              className="mt-1"
            />
            <span className="text-text">{t('prefs.dualCalendar.enable')}</span>
          </label>
        </fieldset>

        {/* Reminder lead hours */}
        <fieldset className="border-t border-border pt-4">
          <legend className="font-medium">{t('reminders.leadHours')}</legend>
          <p className="text-sm text-text-muted mt-1 mb-2">
            {t('reminders.leadHoursSubtitle')}
          </p>
          <label className="flex flex-wrap items-center gap-2 text-sm">
            <input
              type="number"
              min={1}
              max={168}
              step={1}
              value={reminderLeadHours}
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10);
                if (!Number.isNaN(n)) setLocalReminderLeadHours(Math.min(168, Math.max(1, n)));
              }}
              className="w-20 border border-border rounded px-2 py-1 bg-surface text-text"
              dir="ltr"
            />
            <span className="text-slate-700 dark:text-slate-200">{t('reminders.leadHoursUnit')}</span>
          </label>
          <p className="text-xs text-text-muted mt-1">{t('reminders.leadHoursHint')}</p>
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

      {/* Admin-only instance-wide calendar configuration. */}
      {user?.globalRole === 'ADMIN' && <WorkweekSection />}
      {user?.globalRole === 'ADMIN' && <HolidaysSection />}
      {user?.globalRole === 'ADMIN' && <SchedulingSection />}
      {user?.globalRole === 'ADMIN' && <RemindersSection />}
      {user?.globalRole === 'ADMIN' && <DateEditRestrictionSection />}
    </section>
  );
}

function SchedulingSection(): JSX.Element {
  const qc = useQueryClient();
  const t = useT();
  const { data, isLoading } = useQuery({
    queryKey: ['system', 'info'],
    queryFn: fetchSystemInfo,
    staleTime: 5 * 60_000,
  });
  const [rollOffday, setRollOffday] = useState(false);
  const [workingDaysOnly, setWorkingDaysOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (data) {
      setRollOffday(data.schedulingRollOffdayDueDates);
      setWorkingDaysOnly(data.schedulingWorkingDaysOnly);
    }
  }, [data]);

  const saveMut = useMutation({
    mutationFn: async () => {
      await api.put('/settings/instance/scheduling.rollOffdayDueDates', { value: rollOffday });
      await api.put('/settings/instance/scheduling.workingDaysOnly', { value: workingDaysOnly });
    },
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ['system', 'info'] });
    },
    onError: (err) => setError(errorMessage(err, 'Could not save')),
  });

  const dirty =
    data !== undefined
    && (rollOffday !== data.schedulingRollOffdayDueDates
      || workingDaysOnly !== data.schedulingWorkingDaysOnly);

  return (
    <form
      onSubmit={(e: FormEvent) => { e.preventDefault(); saveMut.mutate(); }}
      className="border border-border rounded p-4 space-y-3"
    >
      <h3 className="font-medium">{t('scheduling.title')}</h3>
      <p className="text-sm text-text-muted">{t('scheduling.subtitle')}</p>
      {isLoading && <p className="text-xs text-slate-400">Loading…</p>}
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={rollOffday}
          onChange={(e) => setRollOffday(e.target.checked)}
          className="mt-1"
        />
        <span className="text-text">
          <span className="font-medium">{t('scheduling.rollOffday')}</span>
          <span className="block text-xs text-text-muted mt-0.5">
            {t('scheduling.rollOffdayHint')}
          </span>
        </span>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={workingDaysOnly}
          onChange={(e) => setWorkingDaysOnly(e.target.checked)}
          className="mt-1"
        />
        <span className="text-text">
          <span className="font-medium">{t('scheduling.workingDaysOnly')}</span>
          <span className="block text-xs text-text-muted mt-0.5">
            {t('scheduling.workingDaysOnlyHint')}
          </span>
        </span>
      </label>
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

function RemindersSection(): JSX.Element {
  const qc = useQueryClient();
  const t = useT();
  const { data, isLoading } = useQuery({
    queryKey: ['system', 'info'],
    queryFn: fetchSystemInfo,
    staleTime: 5 * 60_000,
  });
  const [skipOffDays, setSkipOffDays] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (data) setSkipOffDays(data.remindersSkipOffDays);
  }, [data]);

  const saveMut = useMutation({
    mutationFn: async () => {
      await api.put('/settings/instance/reminders.skipOffDays', { value: skipOffDays });
    },
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ['system', 'info'] });
    },
    onError: (err) => setError(errorMessage(err, 'Could not save')),
  });

  const dirty = data !== undefined && skipOffDays !== data.remindersSkipOffDays;

  return (
    <form
      onSubmit={(e: FormEvent) => { e.preventDefault(); saveMut.mutate(); }}
      className="border border-border rounded p-4 space-y-3"
    >
      <h3 className="font-medium">{t('reminders.title')}</h3>
      <p className="text-sm text-text-muted">{t('reminders.subtitle')}</p>
      {isLoading && <p className="text-xs text-slate-400">Loading…</p>}
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={skipOffDays}
          onChange={(e) => setSkipOffDays(e.target.checked)}
          className="mt-1"
        />
        <span className="text-text">
          <span className="font-medium">{t('reminders.skipOffDays')}</span>
          <span className="block text-xs text-text-muted mt-0.5">
            {t('reminders.skipOffDaysHint')}
          </span>
        </span>
      </label>
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          disabled={saveMut.isPending || !dirty}
          className="bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 rounded px-3 py-1 text-sm font-medium disabled:opacity-50"
        >
          {saveMut.isPending ? t('preferences.saving') : t('preferences.save')}
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
      className="border border-border rounded p-4 space-y-3"
    >
      <h3 className="font-medium">Task dates — who can change them? (admin · instance-wide)</h3>
      <p className="text-sm text-text-muted">
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
      className="border border-border rounded p-4 space-y-3"
    >
      <h3 className="font-medium">Workweek (admin · instance-wide)</h3>
      <p className="text-sm text-text-muted">
        Pick the days the instance treats as off-days. They appear in
        <span className="text-danger font-medium"> red </span>
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
        <summary className="cursor-pointer text-text-muted">
          Or pick custom days
        </summary>
        <fieldset className="flex flex-wrap gap-3 text-sm mt-2 ps-3">
          {WEEKDAY_LABELS.map((label, idx) => (
            <label key={idx} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={draft.includes(idx)}
                onChange={() => toggle(idx)}
              />
              <span className={draft.includes(idx) ? 'text-danger font-medium' : ''}>
                {label}
              </span>
            </label>
          ))}
        </fieldset>
      </details>

      {error && <p role="alert" className="text-xs text-danger">{error}</p>}

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

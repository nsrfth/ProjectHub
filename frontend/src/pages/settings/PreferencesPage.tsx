import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { useAuth } from '@/features/auth/AuthContext';
import { updatePreferences } from '@/features/auth/api';
import { setCalendar, setWeekendDays, type Calendar } from '@/lib/calendar';
import { fetchSystemInfo } from '@/features/system/api';
import { api } from '@/lib/api';

// v1.10: per-user display preferences. Currently only the calendar; future
// per-user toggles (timezone, density, language) land here without adding
// another sub-page.
//
// The save flow is: server PATCH → write to localStorage → reload window.
// Reload is the deliberate simple path because the format helpers and the
// date picker read the active calendar at module / render time; a no-reload
// switch would require wrapping every formatter call in a hook.

function errorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const msg = err.response?.data?.error?.message;
    if (typeof msg === 'string' && msg.length) return msg;
  }
  return fallback;
}

export default function PreferencesPage(): JSX.Element {
  const { user, patchUser } = useAuth();
  const initial: Calendar = (user?.calendarPreference ?? 'SHAMSI') as Calendar;
  const [calendar, setLocalCalendar] = useState<Calendar>(initial);
  const [error, setError] = useState<string | null>(null);

  const saveMut = useMutation({
    mutationFn: () => updatePreferences({ calendar }),
    onSuccess: (res) => {
      patchUser({ calendarPreference: res.calendar });
      const changed = setCalendar(res.calendar);
      if (changed) {
        // Hard reload so every mounted formatter / picker picks up the new
        // calendar from its module-level read of getCalendar().
        window.location.reload();
      }
    },
    onError: (err) => setError(errorMessage(err, 'Could not save preferences')),
  });

  function submit(e: FormEvent): void {
    e.preventDefault();
    saveMut.mutate();
  }

  return (
    <section className="space-y-6">
      <header>
        <h2 className="text-lg font-semibold mb-1">Preferences</h2>
        <p className="text-sm text-slate-500">
          Personal display settings. Changes apply only to your account.
        </p>
      </header>

      <form onSubmit={submit} className="border rounded p-4 space-y-3">
        <h3 className="font-medium">Calendar</h3>
        <p className="text-sm text-slate-600">
          Affects how dates and timestamps are rendered across the app — task
          due dates, kanban cards, audit log, comments, the date picker.
        </p>

        <fieldset className="space-y-2">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="calendar"
              value="SHAMSI"
              checked={calendar === 'SHAMSI'}
              onChange={() => setLocalCalendar('SHAMSI')}
              className="mt-1"
            />
            <span>
              <span className="font-medium">Shamsi / Jalali</span> — Persian
              calendar, Persian digits, RTL date layout (e.g. <span dir="rtl">۱ خرداد ۱۴۰۵</span>).
            </span>
          </label>

          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="calendar"
              value="GREGORIAN"
              checked={calendar === 'GREGORIAN'}
              onChange={() => setLocalCalendar('GREGORIAN')}
              className="mt-1"
            />
            <span>
              <span className="font-medium">Gregorian</span> — Western calendar,
              English digits, ISO date format (e.g. <code>2026-05-22</code>).
            </span>
          </label>
        </fieldset>

        {error && <p className="text-xs text-red-600">{error}</p>}

        <div className="flex gap-2 pt-1">
          <button
            type="submit"
            disabled={saveMut.isPending || calendar === initial}
            className="bg-slate-900 text-white rounded px-3 py-1 text-sm font-medium disabled:opacity-50"
          >
            {saveMut.isPending ? 'Saving…' : 'Save (reloads page)'}
          </button>
          {calendar !== initial && (
            <p className="text-xs text-slate-500 self-center">
              The page will reload after saving so every component picks up
              the new calendar.
            </p>
          )}
        </div>
      </form>

      {/* Admin-only section: instance-wide off-days. Persisted as an
          InstanceSetting (calendar.weekend) — every user sees the same
          set of red weekday cells in the date picker. */}
      {user?.globalRole === 'ADMIN' && <WorkweekSection />}
    </section>
  );
}

// ── Admin-only Workweek section ─────────────────────────────────────────
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function WorkweekSection(): JSX.Element {
  const qc = useQueryClient();
  // Seed from the same /system/info the rest of the app already fetched;
  // staleTime keeps this from re-firing on every nav.
  const { data, isLoading } = useQuery({
    queryKey: ['system', 'info'],
    queryFn: fetchSystemInfo,
    staleTime: 5 * 60_000,
  });

  const [draft, setDraft] = useState<number[]>(() => data?.calendarWeekend ?? [0, 6]);
  const [error, setError] = useState<string | null>(null);

  // When the query resolves AFTER mount, hydrate the draft with the
  // server's value (only if the user hasn't already touched it).
  useEffect(() => {
    if (data) setDraft(data.calendarWeekend);
  }, [data]);

  const saveMut = useMutation({
    mutationFn: async () => {
      // PUT to the existing InstanceSetting endpoint. Body shape:
      // { value: <int[]> }. Server doesn't validate the int[] shape per
      // key (it's a generic key/Json store), so /system/info is the one
      // that sanitises on read.
      await api.put('/settings/instance/calendar.weekend', { value: draft });
      return draft;
    },
    onSuccess: (next) => {
      setError(null);
      setWeekendDays(next);
      // Invalidate so /system/info refetches the new value into the
      // React Query cache, then reload so every mounted picker repaints.
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
      className="border rounded p-4 space-y-3"
    >
      <h3 className="font-medium">Workweek (admin · instance-wide)</h3>
      <p className="text-sm text-slate-600">
        Pick the days the instance treats as off-days. They appear in
        <span className="text-red-600 font-medium"> red </span>
        on every date picker. Common conventions: Sat + Sun (Western),
        Thu + Fri (Iranian / Gulf), Fri only (single rest day).
      </p>

      {isLoading && <p className="text-xs text-slate-400">Loading…</p>}

      <fieldset className="flex flex-wrap gap-3 text-sm">
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

      {error && <p className="text-xs text-red-600">{error}</p>}

      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          disabled={saveMut.isPending || !dirty}
          className="bg-slate-900 text-white rounded px-3 py-1 text-sm font-medium disabled:opacity-50"
        >
          {saveMut.isPending ? 'Saving…' : 'Save workweek (reloads page)'}
        </button>
      </div>
    </form>
  );
}

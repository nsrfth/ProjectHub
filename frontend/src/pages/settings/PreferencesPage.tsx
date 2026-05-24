import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import axios from 'axios';
import { useAuth } from '@/features/auth/AuthContext';
import { updatePreferences } from '@/features/auth/api';
import { setCalendar, type Calendar } from '@/lib/calendar';

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
    </section>
  );
}

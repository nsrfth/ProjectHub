import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import {
  createHoliday,
  deleteHoliday,
  fetchHolidays,
  updateHoliday,
  type Holiday,
} from '@/features/holidays/api';
import { setHolidays } from '@/lib/calendar';
import { formatShamsiCalendarDate } from '@/lib/shamsi';
import { ShamsiDatePicker } from '@/lib/ShamsiDatePicker';
import { useT } from '@/lib/i18n';
import HolidayImportPanel from '@/features/settings/HolidayImportPanel';

function errorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const msg = err.response?.data?.error?.message;
    if (typeof msg === 'string' && msg.length) return msg;
  }
  return fallback;
}

export default function HolidaysSection(): JSX.Element {
  const t = useT();
  const qc = useQueryClient();
  const year = new Date().getUTCFullYear();
  const [name, setName] = useState('');
  const [date, setDate] = useState<string | null>(null);
  const [recurring, setRecurring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Holiday | null>(null);

  const { data: holidays = [], isLoading } = useQuery({
    queryKey: ['holidays', 'admin', year],
    queryFn: () =>
      fetchHolidays({
        from: new Date(Date.UTC(year, 0, 1)).toISOString(),
        to: new Date(Date.UTC(year + 1, 11, 31)).toISOString(),
      }),
    staleTime: 60_000,
  });

  function syncCache(next: Holiday[]): void {
    setHolidays(next.map((h) => ({
      id: h.id,
      date: h.date,
      name: h.name,
      recurring: h.recurring,
    })));
    qc.invalidateQueries({ queryKey: ['system', 'info'] });
  }

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!date || !name.trim()) throw new Error('missing');
      if (editing) {
        return updateHoliday(editing.id, { date, name: name.trim(), recurring });
      }
      return createHoliday({ date, name: name.trim(), recurring });
    },
    onSuccess: async () => {
      setError(null);
      setName('');
      setDate(null);
      setRecurring(false);
      setEditing(null);
      const span = await fetchHolidays({
        from: new Date(Date.UTC(year - 1, 0, 1)).toISOString(),
        to: new Date(Date.UTC(year + 2, 11, 31)).toISOString(),
      });
      syncCache(span);
      qc.invalidateQueries({ queryKey: ['holidays'] });
    },
    onError: (err) => setError(errorMessage(err, t('holidays.saveError'))),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteHoliday(id),
    onSuccess: async () => {
      setError(null);
      const span = await fetchHolidays({
        from: new Date(Date.UTC(year - 1, 0, 1)).toISOString(),
        to: new Date(Date.UTC(year + 2, 11, 31)).toISOString(),
      });
      syncCache(span);
      qc.invalidateQueries({ queryKey: ['holidays'] });
    },
    onError: (err) => setError(errorMessage(err, t('holidays.deleteError'))),
  });

  function startEdit(h: Holiday): void {
    setEditing(h);
    setName(h.name);
    setDate(h.date);
    setRecurring(h.recurring);
    setError(null);
  }

  function cancelEdit(): void {
    setEditing(null);
    setName('');
    setDate(null);
    setRecurring(false);
    setError(null);
  }

  function submit(e: FormEvent): void {
    e.preventDefault();
    if (!date || !name.trim()) {
      setError(t('holidays.validation'));
      return;
    }
    saveMut.mutate();
  }

  const upcoming = holidays.filter((h) => new Date(h.date) >= utcToday());

  async function refreshHolidays(): Promise<void> {
    const span = await fetchHolidays({
      from: new Date(Date.UTC(year - 1, 0, 1)).toISOString(),
      to: new Date(Date.UTC(year + 2, 11, 31)).toISOString(),
    });
    syncCache(span);
    qc.invalidateQueries({ queryKey: ['holidays'] });
  }

  return (
    <div className="space-y-4">
      <HolidayImportPanel onImported={refreshHolidays} />

      <form
      onSubmit={submit}
      className="border border-border rounded p-4 space-y-4 bg-surface"
    >
      <div>
        <h3 className="font-medium">{t('holidays.title')}</h3>
        <p className="text-sm text-text-muted mt-1">{t('holidays.subtitle')}</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="font-medium">{t('holidays.name')}</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full border border-border rounded px-2 py-1 text-sm bg-bg"
            maxLength={200}
          />
        </label>
        <label className="block text-sm">
          <span className="font-medium">{t('holidays.date')}</span>
          <div className="mt-1">
            <ShamsiDatePicker value={date} onChange={setDate} />
          </div>
        </label>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={recurring}
          onChange={(e) => setRecurring(e.target.checked)}
        />
        <span>{t('holidays.recurring')}</span>
      </label>

      {error && <p className="text-xs text-danger">{error}</p>}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={saveMut.isPending}
          className="bg-primary text-primary-contrast rounded px-3 py-1 text-sm font-medium disabled:opacity-50"
        >
          {saveMut.isPending ? t('holidays.saving') : editing ? t('holidays.update') : t('holidays.add')}
        </button>
        {editing && (
          <button type="button" onClick={cancelEdit} className="text-sm px-3 py-1 border border-border rounded">
            {t('holidays.cancel')}
          </button>
        )}
      </div>

      {isLoading && <p className="text-xs text-text-muted">{t('holidays.loading')}</p>}

      {!isLoading && upcoming.length > 0 && (
        <div>
          <h4 className="text-sm font-medium mb-2">{t('holidays.upcoming')}</h4>
          <ul className="space-y-1 text-sm">
            {upcoming.map((h) => (
              <li
                key={h.id}
                className="flex flex-wrap items-center gap-2 border-b border-border py-1"
              >
                <span className="text-red-600 font-medium">
                  {formatShamsiCalendarDate(h.date) ?? h.date.slice(0, 10)}
                </span>
                <span className="text-text">{h.name}</span>
                {h.source === 'IMPORT' && (
                  <span className="text-xs text-text-muted">({t('holidays.importedBadge')})</span>
                )}
                {h.recurring && (
                  <span className="text-xs text-text-muted">({t('holidays.recurring')})</span>
                )}
                <span className="ms-auto flex gap-1">
                  <button
                    type="button"
                    className="text-xs text-primary hover:underline"
                    onClick={() => startEdit(h)}
                  >
                    {t('holidays.edit')}
                  </button>
                  <button
                    type="button"
                    className="text-xs text-danger hover:underline"
                    disabled={deleteMut.isPending}
                    onClick={() => deleteMut.mutate(h.id)}
                  >
                    {t('holidays.delete')}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!isLoading && upcoming.length === 0 && (
        <p className="text-sm text-text-muted italic">{t('holidays.empty')}</p>
      )}
    </form>
    </div>
  );
}

function utcToday(): Date {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
}

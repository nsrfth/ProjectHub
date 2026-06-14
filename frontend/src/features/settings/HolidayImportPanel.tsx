import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import axios from 'axios';
import DateObject from 'react-date-object';
import persian from 'react-date-object/calendars/persian';
import {
  importHolidays,
  previewHolidayImport,
  type HolidayImportPreview,
} from '@/features/holidays/api';
import { formatShamsiCalendarDate } from '@/lib/shamsi';
import { useT } from '@/lib/i18n';

function currentJalaliYear(): number {
  const now = new Date();
  const obj = new DateObject({
    date: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
    calendar: persian,
  });
  return obj.year;
}

function errorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const msg = err.response?.data?.error?.message;
    if (typeof msg === 'string' && msg.length) return msg;
  }
  return fallback;
}

export default function HolidayImportPanel({
  onImported,
}: {
  onImported: () => Promise<void>;
}): JSX.Element {
  const t = useT();
  const [jalaliYear, setJalaliYear] = useState(currentJalaliYear);
  const [preview, setPreview] = useState<HolidayImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const previewMut = useMutation({
    mutationFn: () => previewHolidayImport(jalaliYear),
    onSuccess: (data) => {
      setPreview(data);
      setError(null);
    },
    onError: (err) => setError(errorMessage(err, t('holidays.import.previewError'))),
  });

  const importMut = useMutation({
    mutationFn: () => importHolidays(jalaliYear),
    onSuccess: async () => {
      setError(null);
      setPreview(null);
      await onImported();
    },
    onError: (err) => setError(errorMessage(err, t('holidays.import.importError'))),
  });

  return (
    <div className="border border-border rounded p-4 space-y-3 bg-surface">
      <div>
        <h4 className="font-medium">{t('holidays.import.title')}</h4>
        <p className="text-sm text-text-muted mt-1">{t('holidays.import.verifyNote')}</p>
      </div>

      <label className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{t('holidays.import.year')}</span>
        <input
          type="number"
          min={1300}
          max={1500}
          value={jalaliYear}
          onChange={(e) => {
            setJalaliYear(Number.parseInt(e.target.value, 10) || currentJalaliYear());
            setPreview(null);
          }}
          className="w-24 border border-border rounded px-2 py-1 bg-bg"
          dir="ltr"
        />
        <button
          type="button"
          onClick={() => previewMut.mutate()}
          disabled={previewMut.isPending}
          className="text-sm border border-border rounded px-3 py-1 hover:bg-bg"
        >
          {previewMut.isPending ? t('holidays.loading') : t('holidays.import.preview')}
        </button>
      </label>

      {error && <p className="text-xs text-danger">{error}</p>}

      {preview && (
        <div className="space-y-3 text-sm">
          <p className="font-medium">{t('holidays.import.preview')}</p>
          {preview.added.length > 0 && (
            <div>
              <p className="text-text-muted mb-1">
                {t('holidays.import.added')} ({preview.added.length})
              </p>
              <ul className="max-h-32 overflow-y-auto space-y-0.5 text-xs border border-border rounded p-2">
                {preview.added.slice(0, 20).map((row) => (
                  <li key={row.date} className="flex gap-2">
                    <span className="text-red-600 font-medium shrink-0" dir="ltr">
                      {formatShamsiCalendarDate(row.date) ?? row.date.slice(0, 10)}
                    </span>
                    <span>{row.name}</span>
                  </li>
                ))}
                {preview.added.length > 20 && (
                  <li className="text-text-muted italic">…</li>
                )}
              </ul>
            </div>
          )}
          {preview.skipped.length > 0 && (
            <p className="text-text-muted">
              {t('holidays.import.skipped')}: {preview.skipped.length}
            </p>
          )}
          {preview.conflicts.length > 0 && (
            <div>
              <p className="text-text-muted mb-1">
                {t('holidays.import.conflicts')} ({preview.conflicts.length})
              </p>
              <ul className="max-h-24 overflow-y-auto space-y-0.5 text-xs">
                {preview.conflicts.map((c) => (
                  <li key={c.date}>
                    {formatShamsiCalendarDate(c.date) ?? c.date.slice(0, 10)} — {c.datasetName}{' '}
                    ({c.existingName})
                  </li>
                ))}
              </ul>
            </div>
          )}
          <button
            type="button"
            disabled={importMut.isPending || preview.added.length === 0}
            onClick={() => importMut.mutate()}
            className="bg-primary text-primary-contrast rounded px-3 py-1 text-sm font-medium disabled:opacity-50"
          >
            {importMut.isPending ? t('holidays.saving') : t('holidays.import.confirm')}
          </button>
        </div>
      )}
    </div>
  );
}

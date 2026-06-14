import { useMemo, useState } from 'react';
import { COMMON_TIME_ZONES, getBrowserTimeZone, listIanaTimeZones } from '@/lib/datetime';
import { useT } from '@/lib/i18n';

interface TimeZonePickerProps {
  value: string | null;
  onChange: (next: string | null) => void;
}

export default function TimeZonePicker({ value, onChange }: TimeZonePickerProps): JSX.Element {
  const t = useT();
  const detected = getBrowserTimeZone();
  const [query, setQuery] = useState('');

  const allZones = useMemo(() => listIanaTimeZones(), []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      const common = COMMON_TIME_ZONES.filter((z) => allZones.includes(z));
      const rest = allZones.filter((z) => !common.includes(z as (typeof COMMON_TIME_ZONES)[number]));
      return [...common, ...rest.slice(0, 40)];
    }
    return allZones.filter((z) => z.toLowerCase().includes(q)).slice(0, 80);
  }, [allZones, query]);

  const effective = value ?? detected;

  return (
    <div className="space-y-2">
      <p className="text-sm text-text-muted">
        {t('prefs.timezone.detected')}: <code dir="ltr">{detected}</code>
      </p>
      <label className="block text-sm">
        <span className="sr-only">{t('prefs.timezone')}</span>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('prefs.timezone.search')}
          className="w-full rounded border border-border bg-surface px-2 py-1 text-sm"
          dir="ltr"
        />
      </label>
      <div className="max-h-48 overflow-y-auto rounded border border-border">
        <button
          type="button"
          onClick={() => onChange(null)}
          className={[
            'block w-full text-start px-2 py-1.5 text-sm border-b border-border',
            value === null ? 'bg-primary/10 font-medium' : 'hover:bg-surface-muted',
          ].join(' ')}
        >
          {t('prefs.timezone.browserDefault')} ({detected})
        </button>
        {filtered.map((tz) => (
          <button
            key={tz}
            type="button"
            onClick={() => onChange(tz)}
            className={[
              'block w-full text-start px-2 py-1.5 text-sm border-b border-border last:border-b-0',
              effective === tz && value === tz ? 'bg-primary/10 font-medium' : 'hover:bg-surface-muted',
            ].join(' ')}
            dir="ltr"
          >
            {tz}
          </button>
        ))}
      </div>
      <p className="text-xs text-text-muted" dir="ltr">
        {t('prefs.timezone.active')}: {effective}
      </p>
    </div>
  );
}

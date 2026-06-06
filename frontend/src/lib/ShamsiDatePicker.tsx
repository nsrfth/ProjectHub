import DatePicker, { type DateObject } from 'react-multi-date-picker';
import persian from 'react-date-object/calendars/persian';
import gregorian from 'react-date-object/calendars/gregorian';
import persian_fa from 'react-date-object/locales/persian_fa';
import gregorian_en from 'react-date-object/locales/gregorian_en';
import { getCalendar, isWeekend } from './calendar';

// Calendar date picker. Values are ISO 8601 UTC strings (or null) on both
// sides of the API so this drops into anywhere we previously had
// `<input type="date">`. The picker is for CALENDAR DATES (dueDate,
// plannedDate, completedAt, startsOn, …), so we anchor the emitted instant
// to UTC midnight — every viewer reads the same calendar date back via the
// formatShamsiCalendar* helpers regardless of timezone OR active calendar.
//
// v1.10: the picker's display calendar follows the user's preference
// (Shamsi or Gregorian). The component name stays `ShamsiDatePicker` to
// avoid touching every call site; the export now picks the right
// calendar + locale at render based on the active preference.

interface ShamsiDatePickerProps {
  value: string | null;
  onChange: (iso: string | null) => void;
  placeholder?: string;
  disabled?: boolean;
}

export function ShamsiDatePicker({
  value,
  onChange,
  placeholder,
  disabled,
}: ShamsiDatePickerProps): JSX.Element {
  const cal = getCalendar();
  // SHAMSI: Persian calendar + Persian locale + RTL-friendly placement,
  // default placeholder in Farsi.
  // GREGORIAN: Western calendar + English locale + LTR-friendly placement,
  // default placeholder in English.
  const isShamsi = cal === 'SHAMSI';
  return (
    <DatePicker
      calendar={isShamsi ? persian : gregorian}
      locale={isShamsi ? persian_fa : gregorian_en}
      calendarPosition={isShamsi ? 'bottom-right' : 'bottom-left'}
      value={value ? new Date(value) : null}
      onChange={(d: DateObject | null) => {
        if (!d) {
          onChange(null);
          return;
        }
        // DateObject → JS Date → ISO. Anchor to UTC midnight so every viewer
        // reads the same calendar date back regardless of their timezone.
        const jsDate = d.toDate();
        const utc = new Date(
          Date.UTC(jsDate.getFullYear(), jsDate.getMonth(), jsDate.getDate()),
        );
        onChange(utc.toISOString());
      }}
      placeholder={placeholder ?? (isShamsi ? 'انتخاب تاریخ' : 'Pick a date')}
      disabled={disabled}
      inputClass="rounded border-slate-300 px-2 py-1 border text-sm"
      // v1.11: paint admin-configured off-days red. `date.toDate()` gives
      // a local-time Date but `isWeekend` only reads getUTCDay; since the
      // calendar grid renders one date object per cell at local midnight,
      // local-day and UTC-day match here and the red flag lands on the
      // right column. Inline style avoids a Tailwind purge dependency.
      mapDays={({ date }) => {
        if (isWeekend(date.toDate())) {
          return { style: { color: '#dc2626' } };
        }
        return {};
      }}
      // Hide the library's default editing modes that don't apply to a single date.
      multiple={false}
      range={false}
    />
  );
}

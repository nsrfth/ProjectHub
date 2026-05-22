import DatePicker, { type DateObject } from 'react-multi-date-picker';
import persian from 'react-date-object/calendars/persian';
import persian_fa from 'react-date-object/locales/persian_fa';

// Persian-calendar date picker. Values are ISO 8601 UTC strings (or null) on
// both sides of the API so this drops into anywhere we previously had
// `<input type="date">`. The picker is for CALENDAR DATES (dueDate, doneAt),
// so we anchor the emitted instant to UTC midnight — every viewer reads the
// same calendar date back via formatShamsiCalendarDate regardless of TZ.
//
// The underlying library accepts Date / DateObject internally; we convert
// at the boundary.

interface ShamsiDatePickerProps {
  value: string | null;
  onChange: (iso: string | null) => void;
  placeholder?: string;
  disabled?: boolean;
}

export function ShamsiDatePicker({
  value,
  onChange,
  placeholder = 'انتخاب تاریخ',
  disabled,
}: ShamsiDatePickerProps): JSX.Element {
  return (
    <DatePicker
      calendar={persian}
      locale={persian_fa}
      // Render in RTL because Persian numerals + month names read that way.
      // The library handles the rest of the calendar layout itself.
      calendarPosition="bottom-right"
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
      placeholder={placeholder}
      disabled={disabled}
      inputClass="rounded border-slate-300 px-2 py-1 border text-sm"
      // Hide the library's default editing modes that don't apply to a single date.
      multiple={false}
      range={false}
    />
  );
}

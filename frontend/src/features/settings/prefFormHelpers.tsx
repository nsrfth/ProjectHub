import axios from 'axios';

// Shared helpers for the per-user preference forms (Preferences + Date & time).
// Extracted so both settings pages reuse one implementation.

export function normalizeTimeZone(tz: string | null | undefined): string | null {
  if (tz == null) return null;
  const trimmed = tz.trim();
  return trimmed.length ? trimmed : null;
}

export function errorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as
      | { error?: { message?: string; details?: { fieldErrors?: Record<string, string[]> } } }
      | undefined;
    const fieldErrors = data?.error?.details?.fieldErrors;
    if (fieldErrors) {
      const parts = Object.entries(fieldErrors).flatMap(([field, msgs]) =>
        msgs.map((m) => `${field}: ${m}`),
      );
      if (parts.length) return parts.join('; ');
    }
    const msg = data?.error?.message;
    if (typeof msg === 'string' && msg.length) return msg;
  }
  return fallback;
}

export function Radio({
  name, value, checked, onChange, label,
}: {
  name: string; value: string; checked: boolean; onChange: () => void; label: React.ReactNode;
}): JSX.Element {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input type="radio" name={name} value={value} checked={checked} onChange={onChange} className="mt-1" />
      <span className="text-text">{label}</span>
    </label>
  );
}

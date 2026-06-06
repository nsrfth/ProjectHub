import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useT } from '@/lib/i18n';

// v1.30: top-nav search input. Enter-to-submit; navigates to
// /search?q=<encoded>. Deliberately not a live-as-you-type Ctrl-K
// autocomplete — the spec wants a results page, not a palette, and a
// page-scoped query keeps keystroke cost zero on every other route.

export default function SearchInput(): JSX.Element {
  const navigate = useNavigate();
  const t = useT();
  // Pre-fill from the URL so navigating back to the same query
  // doesn't blank the input.
  const [params] = useSearchParams();
  const [value, setValue] = useState<string>(params.get('q') ?? '');

  function submit(e: FormEvent): void {
    e.preventDefault();
    const q = value.trim();
    if (!q) return;
    navigate(`/search?q=${encodeURIComponent(q)}`);
  }

  return (
    <form onSubmit={submit} className="flex-1 max-w-md hidden sm:block" role="search">
      <label className="sr-only" htmlFor="global-search">
        {t('search.placeholder')}
      </label>
      <input
        id="global-search"
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={t('search.placeholder')}
        className={[
          'w-full rounded border px-3 py-1.5 text-sm',
          'bg-slate-50 dark:bg-slate-800',
          'border-slate-200 dark:border-slate-700',
          'placeholder:text-slate-400 dark:placeholder:text-slate-500',
          'focus:outline-none focus:ring-2 focus:ring-slate-400 dark:focus:ring-slate-500',
        ].join(' ')}
      />
    </form>
  );
}

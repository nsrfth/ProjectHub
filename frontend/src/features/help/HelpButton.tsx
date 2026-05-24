import { useNavigate } from 'react-router-dom';
import { useT } from '@/lib/i18n';

// Persistent help button, sibling to NotificationBell. Same pill style so
// they read as a pair in the top-right corner. Clicking jumps to the
// in-app /help route which renders USER_MANUAL.md.
//
// Position: right-14 vs the bell's right-3 — sits just to the left of the
// bell with the same vertical alignment.
export default function HelpButton(): JSX.Element {
  const nav = useNavigate();
  const t = useT();
  return (
    <button
      type="button"
      onClick={() => nav('/help')}
      aria-label={t('corner.help')}
      title={t('corner.help')}
      className="fixed top-3 right-14 z-50 bg-white border border-slate-300 dark:bg-slate-800 dark:border-slate-600 rounded-full w-9 h-9 flex items-center justify-center shadow hover:bg-slate-100 dark:hover:bg-slate-700"
    >
      <span aria-hidden>📖</span>
    </button>
  );
}

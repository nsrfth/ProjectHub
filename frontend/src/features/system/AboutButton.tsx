import { useNavigate } from 'react-router-dom';
import { useT } from '@/lib/i18n';

// Persistent About button, sibling to HelpButton and NotificationBell.
// Same pill style; sits to the left of the help button. Click → /about.
export default function AboutButton(): JSX.Element {
  const nav = useNavigate();
  const t = useT();
  return (
    <button
      type="button"
      onClick={() => nav('/about')}
      aria-label={t('corner.about')}
      title={t('corner.about')}
      className="fixed top-3 right-[6.25rem] z-50 bg-white border border-slate-300 dark:bg-slate-800 dark:border-slate-600 rounded-full w-9 h-9 flex items-center justify-center shadow hover:bg-slate-100 dark:hover:bg-slate-700"
    >
      <span aria-hidden>ℹ️</span>
    </button>
  );
}

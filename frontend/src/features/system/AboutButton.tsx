import { useNavigate } from 'react-router-dom';

// Persistent About button, sibling to HelpButton and NotificationBell.
// Same pill style; sits to the left of the help button. Click → /about.
export default function AboutButton(): JSX.Element {
  const nav = useNavigate();
  return (
    <button
      type="button"
      onClick={() => nav('/about')}
      aria-label="About this app"
      title="About"
      className="fixed top-3 right-[6.25rem] z-50 bg-white border border-slate-300 rounded-full w-9 h-9 flex items-center justify-center shadow hover:bg-slate-100"
    >
      <span aria-hidden>ℹ️</span>
    </button>
  );
}

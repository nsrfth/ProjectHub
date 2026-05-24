import { Link, NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '@/features/auth/AuthContext';
import { useT } from '@/lib/i18n';

// Persistent top navigation. Rendered once by ProtectedRoute so every signed-in
// page picks it up automatically — pages no longer carry their own H1 row.
// Right-side padding (pr-32) leaves room for the three fixed corner buttons
// (About / Help / Notifications) that already live in the top-right.
//
// Order is by frequency-of-use: Dashboard left-most, Settings + Sign out at the
// far right (closer to user-account intent). Admin shows only for global ADMINs.

export default function TopNav(): JSX.Element {
  const { user, signOut } = useAuth();
  const t = useT();
  const loc = useLocation();

  // /settings is a parent route with no element of its own — link to the
  // default child (Preferences) so the click lands on a real page.
  const settingsHref = loc.pathname.startsWith('/settings')
    ? loc.pathname
    : '/settings/preferences';

  const items: Array<{ to: string; label: string }> = [
    { to: '/dashboard', label: t('nav.dashboard') },
    { to: '/projects', label: t('nav.projects') },
    { to: '/calendar', label: t('nav.calendar') },
    { to: '/reports', label: t('nav.reports') },
    { to: '/teams', label: t('nav.teams') },
  ];

  return (
    <nav className="sticky top-0 z-40 bg-white dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 shadow-sm">
      <div className="max-w-7xl mx-auto px-4 pr-32 h-14 flex items-center gap-1">
        <Link
          to="/dashboard"
          className="text-base font-semibold text-slate-900 dark:text-slate-100 mr-3 shrink-0"
        >
          {t('app.name')}
        </Link>
        <div className="flex items-center gap-1 overflow-x-auto">
          {items.map((it) => (
            <NavLink
              key={it.to}
              to={it.to}
              className={({ isActive }) =>
                `px-3 py-1.5 rounded text-sm whitespace-nowrap transition-colors ${
                  isActive
                    ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                    : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'
                }`
              }
            >
              {it.label}
            </NavLink>
          ))}
          {user?.globalRole === 'ADMIN' && (
            <NavLink
              to="/admin"
              className={({ isActive }) =>
                `px-3 py-1.5 rounded text-sm whitespace-nowrap transition-colors ${
                  isActive
                    ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                    : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'
                }`
              }
            >
              {t('nav.admin')}
            </NavLink>
          )}
        </div>
        <div className="ms-auto flex items-center gap-3 shrink-0">
          {user && (
            <NavLink
              to={settingsHref}
              className={({ isActive }) =>
                `px-3 py-1.5 rounded text-sm whitespace-nowrap transition-colors ${
                  isActive
                    ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                    : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'
                }`
              }
            >
              {t('nav.settings')}
            </NavLink>
          )}
          <button
            type="button"
            onClick={() => signOut()}
            className="text-sm text-slate-600 dark:text-slate-300 hover:underline whitespace-nowrap"
          >
            {t('nav.signOut')}
          </button>
        </div>
      </div>
    </nav>
  );
}

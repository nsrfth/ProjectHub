import { NavLink, Link } from 'react-router-dom';
import { useAuth } from '@/features/auth/AuthContext';
import { useT } from '@/lib/i18n';
import {
  IconAdmin,
  IconCalendar,
  IconClose,
  IconDashboard,
  IconProjects,
  IconReports,
  IconTeams,
  IconTrash,
} from './icons';

// v1.24: persistent left sidebar. Primary nav now lives here instead of
// stretched across the top bar — leaves the top free for user identity +
// notifications. Width is fixed at 16rem on md+; below md the sidebar
// becomes a drawer toggled by the hamburger in TopNav (see open/onClose).

interface Props {
  // Drawer mode: when open=true and on a narrow viewport, the sidebar
  // overlays the page from the left. On md+ the sidebar is always visible
  // and these props are ignored.
  open: boolean;
  onClose: () => void;
}

interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  adminOnly?: boolean;
}

export default function LeftSidebar({ open, onClose }: Props): JSX.Element {
  const { user } = useAuth();
  const t = useT();

  const items: NavItem[] = [
    { to: '/dashboard', label: t('nav.dashboard'), icon: IconDashboard },
    { to: '/projects', label: t('nav.projects'), icon: IconProjects },
    { to: '/calendar', label: t('nav.calendar'), icon: IconCalendar },
    { to: '/reports', label: t('nav.reports'), icon: IconReports },
    { to: '/teams', label: t('nav.teams'), icon: IconTeams },
    { to: '/trash', label: 'Trash', icon: IconTrash },
    { to: '/admin', label: t('nav.admin'), icon: IconAdmin, adminOnly: true },
  ];
  const visible = items.filter((it) => !it.adminOnly || user?.globalRole === 'ADMIN');

  return (
    <>
      {/* Drawer overlay — visible only when open on narrow viewports. md+ never
          shows this (the sidebar is in-flow at those widths). */}
      {open && (
        <button
          type="button"
          aria-label="Close menu"
          onClick={onClose}
          className="fixed inset-0 z-40 bg-slate-900/60 md:hidden"
        />
      )}

      <aside
        className={[
          // Layout. md+ : fixed left rail, always visible. Below md : drawer
          // controlled by `open`; slides in from the left.
          'fixed top-0 left-0 z-50 w-64 h-screen flex flex-col',
          'bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800',
          'transition-transform duration-200',
          open ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
        ].join(' ')}
        aria-label="Primary navigation"
      >
        <div className="h-14 flex items-center justify-between px-4 border-b border-slate-200 dark:border-slate-800">
          <Link
            to="/dashboard"
            className="text-base font-semibold text-slate-900 dark:text-slate-100"
            onClick={onClose}
          >
            {t('app.name')}
          </Link>
          {/* Close button only visible in drawer mode. */}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className="md:hidden p-1 rounded text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <IconClose size={20} />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto py-3 px-2">
          <ul className="space-y-0.5">
            {visible.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  onClick={onClose}
                  className={({ isActive }) =>
                    [
                      'flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors',
                      isActive
                        ? // Subtle active state — tinted bg + accent left-border, not full invert.
                          'bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-white font-medium'
                        : 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/60 hover:text-slate-900 dark:hover:text-slate-200',
                    ].join(' ')
                  }
                >
                  {({ isActive }) => (
                    <>
                      <span
                        className={
                          isActive
                            ? 'text-blue-600 dark:text-blue-400'
                            : 'text-slate-400 dark:text-slate-500'
                        }
                      >
                        <item.icon size={18} />
                      </span>
                      <span>{item.label}</span>
                    </>
                  )}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <div className="px-4 py-3 border-t border-slate-200 dark:border-slate-800 text-[11px] text-slate-400 dark:text-slate-500">
          v1.24 · {user?.email}
        </div>
      </aside>
    </>
  );
}

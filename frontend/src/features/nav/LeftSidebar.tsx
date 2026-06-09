import { NavLink, Link } from 'react-router-dom';
import { useAuth } from '@/features/auth/AuthContext';
import { useTeams } from '@/features/teams/TeamsContext';
import { useT } from '@/lib/i18n';
import {
  IconAdmin,
  IconCalendar,
  IconClose,
  IconDashboard,
  IconProjects,
  IconReports,
  IconSettings,
  IconTeams,
  IconTrash,
} from './icons';
import { BrandMark, BrandWordmark } from '@/features/brand/BrandMark';

// v1.24: persistent side rail. v1.31: dashboard redesign. The rail is now
// pinned to the inline-start edge — `start-0` resolves to left in LTR and
// right in RTL, so the same component lays out correctly under both
// `<html dir="ltr">` and `<html dir="rtl">` (lib/i18n.ts sets dir from the
// user's language pref). The drawer transform mirrors the same axis.

interface Props {
  open: boolean;
  onClose: () => void;
}

interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  adminOnly?: boolean;
}

function initials(name: string | undefined, email: string | undefined): string {
  const source = (name || email || '?').trim();
  if (!source) return '?';
  const parts = source.split(/[\s.@_-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

export default function LeftSidebar({ open, onClose }: Props): JSX.Element {
  const { user } = useAuth();
  const { currentTeam } = useTeams();
  const t = useT();

  const items: NavItem[] = [
    { to: '/dashboard', label: t('nav.dashboard'), icon: IconDashboard },
    { to: '/teams', label: t('nav.teams'), icon: IconTeams },
    { to: '/projects', label: t('nav.projects'), icon: IconProjects },
    { to: '/calendar', label: t('nav.calendar'), icon: IconCalendar },
    { to: '/reports', label: t('nav.reports'), icon: IconReports },
    { to: '/settings/preferences', label: t('nav.settings'), icon: IconSettings },
    { to: '/trash', label: t('nav.trash'), icon: IconTrash },
    { to: '/admin', label: t('nav.admin'), icon: IconAdmin, adminOnly: true },
  ];
  const visible = items.filter((it) => !it.adminOnly || user?.globalRole === 'ADMIN');

  return (
    <>
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
          // Pinned to the inline-start edge so it lives on the left in LTR
          // and the right in RTL with no per-language overrides.
          'fixed top-0 start-0 z-50 w-64 h-screen flex flex-col',
          // v1.32.2: track light/dark mode like the rest of the app. The
          // original mockup-faithful `bg-slate-900` was always-dark; users
          // on light theme found the dark rail jarring against the white
          // content area.
          'bg-white text-slate-900 border-e border-slate-200',
          'dark:bg-slate-900 dark:text-slate-100 dark:border-slate-800',
          'transition-transform duration-200',
          // Drawer behaviour. v1.32.1: the previous form
          // `rtl:translate-x-full ltr:-translate-x-full md:translate-x-0`
          // looked correct but lost in Tailwind's compiled source order —
          // the rtl:/ltr: rules emit AFTER md:translate-x-0 so they won at
          // every viewport, hiding the rail entirely on desktop. Flip the
          // logic: the rail is visible by default (no transform), and only
          // BELOW md do we slide it off-screen via the inline-aware
          // -translate. `max-md:` is the dedicated "viewport < md" prefix
          // and composes cleanly with rtl:/ltr:.
          open
            ? 'translate-x-0'
            : 'max-md:ltr:-translate-x-full max-md:rtl:translate-x-full',
        ].join(' ')}
        aria-label="Primary navigation"
      >
        {/* v1.38: brand header uses the new Quad mark + split wordmark
            ("Task" + indigo "Hub"). Persian renders the localised name
            unsplit — see BrandWordmark. */}
        <div className="h-14 flex items-center justify-between px-4 border-b border-slate-200 dark:border-slate-800">
          <Link
            to="/dashboard"
            className="flex items-center gap-2 text-base font-semibold text-slate-900 dark:text-white"
            onClick={onClose}
          >
            <BrandMark variant="filled" size={28} />
            <BrandWordmark name={t('app.name')} />
          </Link>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className="md:hidden p-1 rounded text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
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
                  end={item.to === '/dashboard'}
                  className={({ isActive }) =>
                    [
                      'flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors',
                      isActive
                        ? 'bg-indigo-50 text-indigo-700 font-medium dark:bg-indigo-500/15 dark:text-white'
                        : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800/60 dark:hover:text-slate-100',
                    ].join(' ')
                  }
                >
                  {({ isActive }) => (
                    <>
                      <span
                        className={
                          isActive
                            ? 'text-indigo-600 dark:text-indigo-400'
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

        {/* User profile footer — avatar + name + current team. Click goes
            to Settings → Preferences (closest "your profile" page today). */}
        <Link
          to="/settings/preferences"
          onClick={onClose}
          className="flex items-center gap-3 px-4 py-3 border-t border-slate-200 hover:bg-slate-100 dark:border-slate-800 dark:hover:bg-slate-800/60"
        >
          <span className="w-9 h-9 rounded-full bg-indigo-500 text-white text-xs font-semibold flex items-center justify-center">
            {initials(user?.name, user?.email)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm text-slate-900 dark:text-slate-100 truncate">
              {user?.name || user?.email}
            </span>
            <span className="block text-xs text-slate-500 dark:text-slate-400 truncate">
              {currentTeam?.name ?? ''}
            </span>
          </span>
        </Link>
      </aside>
    </>
  );
}

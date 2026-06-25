import { NavLink, Link } from 'react-router-dom';
import { useAuth } from '@/features/auth/AuthContext';
import { useTeams } from '@/features/teams/TeamsContext';
import { useT } from '@/lib/i18n';
import {
  IconCalendar,
  IconClose,
  IconDashboard,
  IconDashboards,
  IconProjects,
  IconReports,
  IconSettings,
  IconTeams,
  IconWorkload,
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
}

export default function LeftSidebar({ open, onClose }: Props): JSX.Element {
  const t = useT();
  const { user } = useAuth();
  const { teams } = useTeams();
  const showPortfolio =
    user?.globalRole === 'ADMIN' || teams.some((tm) => tm.myRole === 'MANAGER');

  const items: NavItem[] = [
    { to: '/dashboard', label: t('nav.dashboard'), icon: IconDashboard },
    { to: '/teams', label: t('nav.teams'), icon: IconTeams },
    { to: '/projects', label: t('nav.projects'), icon: IconProjects },
    ...(showPortfolio
      ? [{ to: '/portfolio', label: t('nav.portfolio'), icon: IconReports }]
      : []),
    { to: '/planner/my-tasks', label: t('nav.planner'), icon: IconCalendar },
    { to: '/reports', label: t('nav.reports'), icon: IconReports },
    { to: '/workload', label: t('nav.workload'), icon: IconWorkload },
    { to: '/dashboards', label: t('nav.dashboards'), icon: IconDashboards },
  ];
  const visible = items;

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
          'bg-surface text-text border-e border-border',
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
        <div className="h-14 flex items-center justify-between px-4 border-b border-border">
          <Link
            to="/dashboard"
            className="flex items-center gap-2 text-base font-semibold text-text"
            onClick={onClose}
          >
            <BrandMark variant="filled" size={28} />
            <BrandWordmark name={t('app.name')} />
          </Link>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className="md:hidden p-1 rounded text-text-muted hover:bg-bg-elevated"
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
                        ? 'bg-primary/10 text-primary font-medium'
                        : 'text-text-muted hover:bg-bg-elevated hover:text-text',
                    ].join(' ')
                  }
                >
                  {({ isActive }) => (
                    <>
                      <span
                        className={
                          isActive ? 'text-primary' : 'text-text-muted'
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

        {/* Settings pinned to the bottom of the rail (where the user footer
            used to be) — account/preferences live in the top-right menu. */}
        <div className="px-2 py-3 border-t border-border">
          <NavLink
            to="/settings"
            onClick={onClose}
            className={({ isActive }) =>
              [
                'flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors',
                isActive
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'text-text-muted hover:bg-bg-elevated hover:text-text',
              ].join(' ')
            }
          >
            {({ isActive }) => (
              <>
                <span className={isActive ? 'text-primary' : 'text-text-muted'}>
                  <IconSettings size={18} />
                </span>
                <span>{t('nav.settings')}</span>
              </>
            )}
          </NavLink>
        </div>
      </aside>
    </>
  );
}

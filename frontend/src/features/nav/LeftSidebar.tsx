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
import { useSidebarCollapsed } from '@/lib/sidebar';
import SidebarToggle from './SidebarToggle';

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
  // Effective collapsed state (user choice, or forced on tablet viewports).
  // Collapsed styling is applied only from `md:` up — below md the rail is a
  // slide-in drawer and always shows full labels.
  const collapsed = useSidebarCollapsed();
  const showPortfolio =
    user?.globalRole === 'ADMIN' || teams.some((tm) => tm.myRole === 'MANAGER');

  const items: NavItem[] = [
    { to: '/dashboard', label: t('nav.dashboard'), icon: IconDashboard },
    { to: '/teams', label: t('nav.teams'), icon: IconTeams },
    { to: '/projects', label: t('nav.projects'), icon: IconProjects },
    ...(showPortfolio
      ? [{ to: '/portfolio', label: t('nav.portfolio'), icon: IconReports }]
      : []),
    { to: '/timesheets', label: t('nav.timesheets'), icon: IconWorkload },
    { to: '/planner/my-tasks', label: t('nav.planner'), icon: IconCalendar },
    { to: '/me/referrals', label: t('nav.myReferrals'), icon: IconReports },
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
          'fixed top-0 start-0 z-50 h-screen flex flex-col',
          // Width: full 16rem drawer/rail by default; from md up, shrink to a
          // 4rem (~64px) icon-only rail when collapsed. Animating width (not
          // just transform) gives the smooth expand/collapse.
          'w-64',
          collapsed ? 'md:w-16' : 'md:w-64',
          // v1.32.2: track light/dark mode like the rest of the app. The
          // original mockup-faithful `bg-slate-900` was always-dark; users
          // on light theme found the dark rail jarring against the white
          // content area.
          'bg-surface text-text border-e border-border',
          'transition-[transform,width] duration-200 ease-in-out',
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
        <div
          className={[
            // Base (also the mobile-drawer layout, where `collapsed` is true
            // by viewport but the rail is a full-width drawer): brand at the
            // inline-start, close button at the inline-end.
            'h-14 flex items-center justify-between px-4 border-b border-border',
            // From md up, when collapsed, centre the lone brand mark in the
            // narrow rail (the expand toggle sits in its own row below).
            collapsed ? 'md:justify-center md:px-2' : '',
          ].join(' ')}
        >
          <Link
            to="/dashboard"
            className="flex items-center gap-2 text-base font-semibold text-text"
            onClick={onClose}
          >
            <BrandMark variant="filled" size={28} />
            {/* Wordmark is dropped in the collapsed rail (md+) but stays in the
                mobile drawer, where labels are always shown. */}
            <span className={collapsed ? 'md:hidden' : ''}>
              <BrandWordmark name={t('app.name')} />
            </span>
          </Link>
          {/* Desktop collapse/expand toggle — hidden when collapsed (the rail
              has no room); a dedicated expand affordance sits in the nav
              below. Hidden below md, where the drawer close button rules. */}
          {!collapsed && <SidebarToggle />}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className="md:hidden p-1 rounded text-text-muted hover:bg-bg-elevated"
          >
            <IconClose size={20} />
          </button>
        </div>

        {/* When collapsed, surface the expand toggle as its own centred row so
            the user can always get back — the header toggle is hidden to save
            width. Only rendered at md+ (the collapsed state never applies in
            the mobile drawer). */}
        {collapsed && (
          <div className="hidden md:flex justify-center py-2 border-b border-border">
            <SidebarToggle />
          </div>
        )}

        <nav className="flex-1 overflow-y-auto py-3 px-2">
          <ul className="space-y-0.5">
            {visible.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  onClick={onClose}
                  end={item.to === '/dashboard'}
                  // Native tooltip stands in for the hidden label on the
                  // collapsed rail.
                  title={collapsed ? item.label : undefined}
                  className={({ isActive }) =>
                    [
                      'flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors',
                      collapsed ? 'md:justify-center md:px-0' : '',
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
                      <span className={collapsed ? 'md:hidden' : ''}>
                        {item.label}
                      </span>
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
            title={collapsed ? t('nav.settings') : undefined}
            className={({ isActive }) =>
              [
                'flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors',
                collapsed ? 'md:justify-center md:px-0' : '',
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
                <span className={collapsed ? 'md:hidden' : ''}>
                  {t('nav.settings')}
                </span>
              </>
            )}
          </NavLink>
        </div>
      </aside>
    </>
  );
}

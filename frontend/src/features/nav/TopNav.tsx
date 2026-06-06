import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import NotificationBell from '@/features/notifications/NotificationBell';
import UserMenu from './UserMenu';
import LeftSidebar from './LeftSidebar';
import { IconMenu } from './icons';
import SearchInput from '@/features/search/SearchInput';
import { useTeams } from '@/features/teams/TeamsContext';
import { useT, type MessageKey } from '@/lib/i18n';

// v1.24: slim top bar. v1.31 redesign: padding switched to logical
// `ps-64` so the bar sits beside the sidebar on the inline-start edge
// in both LTR and RTL. A page-title slot now lives at the inline-start
// of the bar, and a "+ New Task" button at the inline-end — both
// surface what the dashboard mockup expects without making the bar
// page-specific.

const TITLE_BY_PREFIX: Array<[string, MessageKey]> = [
  ['/dashboard', 'nav.dashboard'],
  ['/teams', 'nav.teams'],
  ['/projects', 'nav.projects'],
  ['/calendar', 'nav.calendar'],
  ['/reports', 'nav.reports'],
  ['/trash', 'nav.dashboard'], // fall through to a generic header
  ['/admin', 'nav.admin'],
  ['/settings', 'nav.settings'],
  ['/search', 'search.title'],
];

function titleKeyFor(pathname: string): MessageKey | null {
  for (const [prefix, key] of TITLE_BY_PREFIX) {
    if (pathname === prefix || pathname.startsWith(prefix + '/')) return key;
  }
  return null;
}

export default function TopNav(): JSX.Element {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const t = useT();
  const { pathname } = useLocation();
  const { currentTeam } = useTeams();
  const titleKey = titleKeyFor(pathname);

  // "+ New Task" deep-link target. We don't have a global new-task modal,
  // so the simplest honest behaviour is: drop the user on Projects, where
  // every project card has a New-task affordance. If a team is selected
  // and the user is already inside a project, the link still goes to the
  // projects index — keeps the button predictable from any page.
  const newTaskHref = currentTeam ? '/projects' : '/teams';

  return (
    <>
      <LeftSidebar open={drawerOpen} onClose={() => setDrawerOpen(false)} />

      <header
        className={[
          'sticky top-0 z-30 h-14 flex items-center gap-3',
          'bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800',
          'px-4 md:ps-72',
        ].join(' ')}
      >
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          className="md:hidden p-2 rounded text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
          aria-label="Open menu"
        >
          <IconMenu size={20} />
        </button>

        {/* Page title — inline-start of the bar. */}
        {titleKey && (
          <h1 className="hidden sm:block text-lg font-semibold text-slate-900 dark:text-slate-100 truncate">
            {t(titleKey)}
          </h1>
        )}

        {/* v1.30: global search input grows in the middle. */}
        <SearchInput />
        <div className="flex-1 sm:hidden" />

        <div className="flex items-center gap-2">
          <NotificationBell />

          {/* + New Task. Visible only when there's a team context to deep-
              link into; on fresh installs it falls back to /teams. */}
          <Link
            to={newTaskHref}
            className="hidden sm:inline-flex items-center gap-1 rounded-md bg-indigo-500 hover:bg-indigo-600 text-white text-sm font-medium px-3 py-1.5"
          >
            <span aria-hidden className="text-base leading-none">+</span>
            {t('dashboard.newTask')}
          </Link>

          <UserMenu />
        </div>
      </header>
    </>
  );
}

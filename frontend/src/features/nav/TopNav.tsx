import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import NotificationBell from '@/features/notifications/NotificationBell';
import UserMenu from './UserMenu';
import LeftSidebar from './LeftSidebar';
import { IconMenu } from './icons';
import SearchInput from '@/features/search/SearchInput';
import { useT, type MessageKey } from '@/lib/i18n';
import { useSidebarCollapsed } from '@/lib/sidebar';

// v1.24: slim top bar. v1.31 redesign: padding switched to logical
// `ps-64` so the bar sits beside the sidebar on the inline-start edge
// in both LTR and RTL. A page-title slot lives at the inline-start of
// the bar; notifications and user menu at the inline-end.

const TITLE_BY_PREFIX: Array<[string, MessageKey]> = [
  ['/dashboard', 'nav.dashboard'],
  ['/teams', 'nav.teams'],
  ['/projects', 'nav.projects'],
  ['/planner', 'nav.planner'],
  ['/reports', 'nav.reports'],
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
  const titleKey = titleKeyFor(pathname);
  const collapsed = useSidebarCollapsed();

  return (
    <>
      <LeftSidebar open={drawerOpen} onClose={() => setDrawerOpen(false)} />

      <header
        className={[
          'sticky top-0 z-30 h-14 flex items-center gap-3',
          'bg-surface border-b border-border text-text',
          'px-4 transition-[padding] duration-200 ease-in-out',
          // Sit beside the rail; the extra inline-start indent (ps-72 vs the
          // rail's 64) keeps the title clear of the rail edge when expanded.
          collapsed ? 'md:ps-20' : 'md:ps-72',
        ].join(' ')}
      >
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          className="md:hidden p-2 rounded text-text-muted hover:bg-bg-elevated"
          aria-label="Open menu"
        >
          <IconMenu size={20} />
        </button>

        {/* Page title — inline-start of the bar. */}
        {titleKey && (
          <h1 className="hidden sm:block text-lg font-semibold text-text truncate">
            {t(titleKey)}
          </h1>
        )}

        {/* v1.30: global search grows to fill the bar. */}
        <SearchInput />

        {/* ms-auto pins the account controls to the inline-end, including on
            mobile where the search is hidden. */}
        <div className="flex items-center gap-2 ms-auto">
          <NotificationBell />
          <UserMenu />
        </div>
      </header>
    </>
  );
}

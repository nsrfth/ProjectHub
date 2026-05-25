import { useState } from 'react';
import NotificationBell from '@/features/notifications/NotificationBell';
import UserMenu from './UserMenu';
import LeftSidebar from './LeftSidebar';
import { IconMenu } from './icons';

// v1.24: slim top bar. Primary nav moved to the left sidebar; the top bar
// now carries just three things on the right:
//   - notifications bell (with badge)
//   - account menu (avatar dropdown with About / Help / Settings / Sign out)
// On narrow viewports (< md) it also renders a hamburger that toggles the
// sidebar drawer.

export default function TopNav(): JSX.Element {
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <>
      <LeftSidebar open={drawerOpen} onClose={() => setDrawerOpen(false)} />

      <header
        className={[
          // Stick to the top + offset by sidebar width on md+. Mobile: full width.
          'sticky top-0 z-30 h-14 flex items-center justify-between gap-2',
          'bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800',
          'px-4 md:pl-72',
        ].join(' ')}
      >
        {/* Hamburger: mobile-only. Hidden on md+ since the sidebar is visible. */}
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          className="md:hidden p-2 rounded text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
          aria-label="Open menu"
        >
          <IconMenu size={20} />
        </button>

        {/* Page title placeholder — gives the bar visual weight on mobile when
            the sidebar is hidden. md+ : flex spacer pushes the right cluster
            against the edge. */}
        <div className="flex-1" />

        <div className="flex items-center gap-1">
          {/* Bell rides in the nav as a regular icon button now (no more
              fixed-position overlay). It has its own badge + dropdown. */}
          <NotificationBell />
          <UserMenu />
        </div>
      </header>
    </>
  );
}

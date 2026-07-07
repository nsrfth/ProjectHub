import { useT } from '@/lib/i18n';
import { useSidebarCollapsed, toggleSidebar } from '@/lib/sidebar';
import { IconSidebarToggle } from './icons';

// v2.5.47: collapse/expand control for the desktop side rail. Icon-only in
// both states (the rail is too narrow for a label when collapsed), so the
// accessible name comes from aria-label + native title tooltip. Keyboard is
// free: it's a <button>, so Tab reaches it and Enter/Space activate it.
// `aria-expanded` reflects the *expanded* rail state for assistive tech.
//
// Hidden below md — on phones the sidebar is a slide-in drawer with its own
// open/close affordance, so a collapse toggle would be meaningless there.
export default function SidebarToggle(): JSX.Element {
  const t = useT();
  const collapsed = useSidebarCollapsed();
  const label = collapsed ? t('nav.expandSidebar') : t('nav.collapseSidebar');

  return (
    <button
      type="button"
      onClick={toggleSidebar}
      aria-expanded={!collapsed}
      aria-label={label}
      title={label}
      className="hidden md:inline-flex p-1.5 rounded text-text-muted hover:bg-bg-elevated hover:text-text transition-colors"
    >
      <IconSidebarToggle size={20} />
    </button>
  );
}

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/features/auth/AuthContext';
import { useT } from '@/lib/i18n';
import { IconChevronDown, IconHelp, IconInfo, IconSettings, IconSignOut } from './icons';

// v1.24: avatar-button + dropdown. Replaces the loose grid of corner buttons
// (About / Help / Settings link / Sign-out link) that lived in v1.15-v1.23.
// Cleaner visual hierarchy — one circle button on the right that opens a
// menu of account-level actions.
//
// Click-outside + Escape close. No portal needed because the menu sits
// inside the top bar's flex container and z-index puts it above the page.

function initials(name: string | undefined, email: string | undefined): string {
  const source = (name || email || '?').trim();
  if (!source) return '?';
  const parts = source.split(/[\s.@_-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

export default function UserMenu(): JSX.Element | null {
  const { user, signOut } = useAuth();
  const t = useT();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!user) return null;

  function go(path: string): void {
    setOpen(false);
    nav(path);
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((x) => !x)}
        className="flex items-center gap-2 rounded-full hover:bg-bg-elevated ps-1 pe-2 py-1"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
      >
        <span className="w-8 h-8 rounded-full bg-primary text-primary-contrast text-xs font-semibold flex items-center justify-center">
          {initials(user.name, user.email)}
        </span>
        <span className="hidden sm:inline text-sm text-text">
          {user.name || user.email}
        </span>
        <IconChevronDown size={14} className="text-text-muted" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute end-0 mt-2 w-60 rounded-md shadow-lg bg-surface border border-border overflow-hidden z-50"
        >
          <div className="px-4 py-3 border-b border-border">
            <p className="text-sm font-medium text-text truncate">
              {user.name}
            </p>
            <p className="text-xs text-text-muted truncate">{user.email}</p>
            <p className="text-[10px] uppercase tracking-wide text-text-muted mt-1">
              {user.globalRole}
            </p>
          </div>
          <MenuButton icon={<IconSettings size={16} />} label={t('nav.settings')} onClick={() => go('/settings/preferences')} />
          <MenuButton icon={<IconHelp size={16} />} label={t('corner.help')} onClick={() => go('/help')} />
          <MenuButton icon={<IconInfo size={16} />} label={t('corner.about')} onClick={() => go('/about')} />
          <div className="border-t border-border" />
          <MenuButton
            icon={<IconSignOut size={16} />}
            label={t('nav.signOut')}
            onClick={() => {
              setOpen(false);
              void signOut();
            }}
            danger
          />
        </div>
      )}
    </div>
  );
}

function MenuButton({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      role="menuitem"
      className={[
        'w-full flex items-center gap-3 px-4 py-2 text-sm text-left transition-colors',
        danger
          ? 'text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20'
          : 'text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700',
      ].join(' ')}
    >
      <span className={danger ? 'text-red-500' : 'text-slate-400 dark:text-slate-500'}>
        {icon}
      </span>
      {label}
    </button>
  );
}

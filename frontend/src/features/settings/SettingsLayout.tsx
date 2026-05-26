import { NavLink, Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '@/features/auth/AuthContext';
import { useTeams } from '@/features/teams/TeamsContext';
import { useT } from '@/lib/i18n';

// Role-gated sidebar shell shared by every Settings sub-page. Each entry
// declares the GlobalRole that may see it; entries the current user lacks are
// hidden from the sidebar rather than greyed out. The route itself ALSO
// guards in case someone types the URL directly.
//
// Phase 1: all four sub-pages are ADMIN-only. The `roles` field is kept so
// later phases can opt items in for MANAGER/MEMBER without touching the
// layout shape.

type SettingsRole = 'ADMIN' | 'MANAGER' | 'MEMBER';

interface NavItem {
  to: string;
  labelKey: string;
  descriptionKey: string;
  roles: SettingsRole[];
}

const NAV: NavItem[] = [
  {
    to: '/settings/preferences',
    labelKey: 'settings.nav.preferences',
    descriptionKey: 'settings.nav.preferencesDesc',
    roles: ['ADMIN', 'MANAGER', 'MEMBER'],
  },
  // v1.23: per-team roles + permission matrix. Listing is open to any
  // team member; mutations gated by team.manage_roles on the server.
  {
    to: '/settings/roles',
    labelKey: 'settings.nav.roles',
    descriptionKey: 'settings.nav.rolesDesc',
    roles: ['ADMIN', 'MANAGER', 'MEMBER'],
  },
  {
    to: '/settings/directories',
    labelKey: 'settings.nav.directories',
    descriptionKey: 'settings.nav.directoriesDesc',
    roles: ['ADMIN'],
  },
  {
    to: '/settings/security',
    labelKey: 'settings.nav.security',
    descriptionKey: 'settings.nav.securityDesc',
    roles: ['ADMIN', 'MEMBER'],
  },
  {
    to: '/settings/audit',
    labelKey: 'settings.nav.audit',
    descriptionKey: 'settings.nav.auditDesc',
    roles: ['ADMIN', 'MANAGER'],
  },
  {
    to: '/settings/api',
    labelKey: 'settings.nav.api',
    descriptionKey: 'settings.nav.apiDesc',
    roles: ['ADMIN', 'MANAGER', 'MEMBER'],
  },
  // v1.27: automatic database backups. Admin-only because it exposes file
  // download + scheduler config that affects the whole instance.
  {
    to: '/settings/backups',
    labelKey: 'settings.nav.backups',
    descriptionKey: 'settings.nav.backupsDesc',
    roles: ['ADMIN'],
  },
];

export default function SettingsLayout(): JSX.Element {
  const { user, loading } = useAuth();
  const { teams } = useTeams();
  const location = useLocation();
  const t = useT();

  if (loading) return <div className="p-8 text-sm text-slate-500 dark:text-slate-400">Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;

  // Effective roles for sidebar gating. globalRole is always present;
  // we additionally lift 'MANAGER' into the role set when the user manages
  // at least one team (it's a team-scoped role, not a global one — but the
  // sidebar treats it as a tier so MANAGERs see the Audit entry).
  const effective = new Set<SettingsRole>([user.globalRole as SettingsRole]);
  if (teams.some((t) => t.myRole === 'MANAGER')) effective.add('MANAGER');

  const visible = NAV.filter((item) => item.roles.some((r) => effective.has(r)));
  if (visible.length === 0) return <Navigate to="/dashboard" replace />;

  // Bare /settings — land on the first item the user can actually see.
  if (location.pathname === '/settings' || location.pathname === '/settings/') {
    return <Navigate to={visible[0].to} replace />;
  }

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <h1 className="text-2xl font-semibold mb-6">{t('settings.title')}</h1>

      <div className="grid grid-cols-1 md:grid-cols-[200px_1fr] gap-6">
        <nav className="bg-white dark:bg-slate-800 rounded shadow p-2 h-fit">
          <ul className="space-y-1">
            {visible.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  className={({ isActive }) =>
                    [
                      'block rounded px-3 py-2 text-sm',
                      isActive
                        ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                        : 'text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-700',
                    ].join(' ')
                  }
                >
                  <span className="font-medium">{t(item.labelKey)}</span>
                  <span className="block text-[11px] opacity-70">{t(item.descriptionKey)}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <main className="bg-white dark:bg-slate-800 rounded shadow p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

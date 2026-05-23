import { Link, NavLink, Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '@/features/auth/AuthContext';

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
  label: string;
  description: string;
  roles: SettingsRole[];
}

const NAV: NavItem[] = [
  {
    to: '/settings/directories',
    label: 'Directories',
    description: 'Users, teams, invites',
    roles: ['ADMIN'],
  },
  {
    to: '/settings/security',
    label: 'Security',
    description: 'Auth, sessions, password policy',
    roles: ['ADMIN'],
  },
  {
    to: '/settings/audit',
    label: 'Audit',
    description: 'Activity + sign-in log',
    roles: ['ADMIN'],
  },
  {
    to: '/settings/api',
    label: 'API & Webhooks',
    description: 'Outbound integrations, API keys',
    roles: ['ADMIN'],
  },
];

export default function SettingsLayout(): JSX.Element {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <div className="p-8 text-sm text-slate-500">Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;

  // Filter the sidebar to what this user may see. If they're not in any
  // role bucket the layout has no entries, so we bounce them out.
  const visible = NAV.filter((item) =>
    item.roles.includes(user.globalRole as SettingsRole),
  );
  if (visible.length === 0) return <Navigate to="/dashboard" replace />;

  // Bare /settings — land on the first item the user can actually see.
  if (location.pathname === '/settings' || location.pathname === '/settings/') {
    return <Navigate to={visible[0].to} replace />;
  }

  return (
    <div className="min-h-screen p-8 max-w-5xl mx-auto">
      <header className="mb-6">
        <Link to="/dashboard" className="text-sm underline">
          ← Back to dashboard
        </Link>
        <h1 className="text-2xl font-semibold mt-2">Settings</h1>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-[200px_1fr] gap-6">
        <nav className="bg-white rounded shadow p-2 h-fit">
          <ul className="space-y-1">
            {visible.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  className={({ isActive }) =>
                    [
                      'block rounded px-3 py-2 text-sm',
                      isActive
                        ? 'bg-slate-900 text-white'
                        : 'text-slate-700 hover:bg-slate-100',
                    ].join(' ')
                  }
                >
                  <span className="font-medium">{item.label}</span>
                  <span className="block text-[11px] opacity-70">{item.description}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <main className="bg-white rounded shadow p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

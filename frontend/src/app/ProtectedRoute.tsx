import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '@/features/auth/AuthContext';
import TopNav from '@/features/nav/TopNav';

// Guards routes that require authentication. While the initial refresh is in
// flight we render nothing rather than flicker to /login.
//
// v1.24 layout: LeftSidebar + TopNav render once here so every authenticated
// route inherits them. The sidebar is fixed at md:left-0 with a 16rem width;
// the main content is offset by `md:pl-64` so it doesn't sit under the
// sidebar. On narrow viewports the sidebar becomes a drawer toggled by the
// hamburger in TopNav (see features/nav/TopNav.tsx + LeftSidebar.tsx).
//
// The old fixed-position AboutButton / HelpButton / NotificationBell are
// gone — About + Help are now in the user-menu dropdown; the bell sits
// inside the TopNav flex row.
export default function ProtectedRoute(): JSX.Element | null {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      <TopNav />
      <main className="md:ps-64">
        <Outlet />
      </main>
    </div>
  );
}

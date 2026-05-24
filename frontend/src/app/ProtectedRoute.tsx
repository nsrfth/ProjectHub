import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '@/features/auth/AuthContext';
import NotificationBell from '@/features/notifications/NotificationBell';
import HelpButton from '@/features/help/HelpButton';
import AboutButton from '@/features/system/AboutButton';
import TopNav from '@/features/nav/TopNav';

// Guards routes that require authentication. While the initial refresh is in
// flight we render nothing rather than flicker to /login. The corner pills
// (About / Help / Notifications) and the persistent TopNav render once here
// so every authenticated route gets them without per-page boilerplate.
export default function ProtectedRoute(): JSX.Element | null {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  return (
    <>
      <AboutButton />
      <HelpButton />
      <NotificationBell />
      <TopNav />
      <Outlet />
    </>
  );
}

import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '@/features/auth/AuthContext';
import NotificationBell from '@/features/notifications/NotificationBell';

// Guards routes that require authentication. While the initial refresh is in
// flight we render nothing rather than flicker to /login. The bell renders
// once here so every authenticated route gets it without per-page boilerplate.
export default function ProtectedRoute(): JSX.Element | null {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  return (
    <>
      <NotificationBell />
      <Outlet />
    </>
  );
}

import { createBrowserRouter, Navigate } from 'react-router-dom';
import LoginPage from '@/pages/LoginPage';
import RegisterPage from '@/pages/RegisterPage';
import DashboardPage from '@/pages/DashboardPage';
import TeamsPage from '@/pages/TeamsPage';
import ProjectsPage from '@/pages/ProjectsPage';
import TasksPage from '@/pages/TasksPage';
import TaskDetailPage from '@/pages/TaskDetailPage';
import AdminPage from '@/pages/AdminPage';
import ReportsPage from '@/pages/ReportsPage';
import SettingsLayout from '@/features/settings/SettingsLayout';
import DirectoriesPage from '@/pages/settings/DirectoriesPage';
import SecurityPage from '@/pages/settings/SecurityPage';
import AuditPage from '@/pages/settings/AuditPage';
import ApiWebhooksPage from '@/pages/settings/ApiWebhooksPage';
import ProtectedRoute from './ProtectedRoute';

export const router = createBrowserRouter([
  { path: '/', element: <Navigate to="/dashboard" replace /> },
  { path: '/login', element: <LoginPage /> },
  { path: '/register', element: <RegisterPage /> },
  {
    element: <ProtectedRoute />,
    children: [
      { path: '/dashboard', element: <DashboardPage /> },
      { path: '/teams', element: <TeamsPage /> },
      { path: '/projects', element: <ProjectsPage /> },
      { path: '/projects/:projectId/tasks', element: <TasksPage /> },
      { path: '/projects/:projectId/tasks/:taskId', element: <TaskDetailPage /> },
      { path: '/admin', element: <AdminPage /> },
      { path: '/reports', element: <ReportsPage /> },
      {
        path: '/settings',
        element: <SettingsLayout />,
        children: [
          { path: 'directories', element: <DirectoriesPage /> },
          { path: 'security', element: <SecurityPage /> },
          { path: 'audit', element: <AuditPage /> },
          { path: 'api', element: <ApiWebhooksPage /> },
        ],
      },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
]);

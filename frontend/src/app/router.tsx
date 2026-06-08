import { createBrowserRouter, Navigate } from 'react-router-dom';
import LoginPage from '@/pages/LoginPage';
import DashboardPage from '@/pages/DashboardPage';
import TeamsPage from '@/pages/TeamsPage';
import ProjectsPage from '@/pages/ProjectsPage';
import TasksPage from '@/pages/TasksPage';
import TaskDetailPage from '@/pages/TaskDetailPage';
import ProjectGanttPage from '@/pages/ProjectGanttPage';
import AdminPage from '@/pages/AdminPage';
import ReportsPage from '@/pages/ReportsPage';
import SettingsLayout from '@/features/settings/SettingsLayout';
import DirectoriesPage from '@/pages/settings/DirectoriesPage';
import SecurityPage from '@/pages/settings/SecurityPage';
import AuditPage from '@/pages/settings/AuditPage';
import ApiWebhooksPage from '@/pages/settings/ApiWebhooksPage';
import PreferencesPage from '@/pages/settings/PreferencesPage';
import RolesPage from '@/pages/settings/RolesPage';
import BackupsPage from '@/pages/settings/BackupsPage';
import LabelsPage from '@/pages/settings/LabelsPage';
import SearchPage from '@/pages/SearchPage';
import HelpPage from '@/pages/HelpPage';
import AboutPage from '@/pages/AboutPage';
import CalendarPage from '@/pages/CalendarPage';
import TrashPage from '@/pages/TrashPage';
import ProtectedRoute from './ProtectedRoute';

export const router = createBrowserRouter([
  { path: '/', element: <Navigate to="/dashboard" replace /> },
  { path: '/login', element: <LoginPage /> },
  // v1.30.11 (S-9): /register route + RegisterPage removed. Public
  // self-registration was an account-enumeration channel. New accounts
  // come from the v1.26 admin-provisioning flow at Settings → Admin →
  // New user. Bootstrap is `prisma db seed` (SEED_ADMIN_EMAIL +
  // SEED_ADMIN_PASSWORD), not the frontend.
  {
    element: <ProtectedRoute />,
    children: [
      { path: '/dashboard', element: <DashboardPage /> },
      { path: '/teams', element: <TeamsPage /> },
      { path: '/projects', element: <ProjectsPage /> },
      { path: '/projects/:projectId/tasks', element: <TasksPage /> },
      { path: '/projects/:projectId/tasks/:taskId', element: <TaskDetailPage /> },
      // v1.42: per-project Gantt report.
      { path: '/projects/:projectId/reports/gantt', element: <ProjectGanttPage /> },
      { path: '/admin', element: <AdminPage /> },
      { path: '/reports', element: <ReportsPage /> },
      { path: '/calendar', element: <CalendarPage /> },
      { path: '/trash', element: <TrashPage /> },
      { path: '/search', element: <SearchPage /> },
      { path: '/help', element: <HelpPage /> },
      { path: '/about', element: <AboutPage /> },
      {
        path: '/settings',
        element: <SettingsLayout />,
        children: [
          { path: 'preferences', element: <PreferencesPage /> },
          { path: 'roles', element: <RolesPage /> },
          { path: 'labels', element: <LabelsPage /> },
          { path: 'directories', element: <DirectoriesPage /> },
          { path: 'security', element: <SecurityPage /> },
          { path: 'audit', element: <AuditPage /> },
          { path: 'api', element: <ApiWebhooksPage /> },
          { path: 'backups', element: <BackupsPage /> },
        ],
      },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
]);

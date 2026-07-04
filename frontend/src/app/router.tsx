import { createBrowserRouter, Navigate } from 'react-router-dom';
import LoginPage from '@/pages/LoginPage';
import DashboardPage from '@/pages/DashboardPage';
import TeamsPage from '@/pages/TeamsPage';
import ProjectsPage from '@/pages/ProjectsPage';
import TasksPage from '@/pages/TasksPage';
import TaskDetailPage from '@/pages/TaskDetailPage';
import ProjectGanttPage from '@/pages/ProjectGanttPage';
import ProjectStatusPage from '@/pages/ProjectStatusPage';
import CorrespondencePage from '@/pages/CorrespondencePage';
import MyReferralsPage from '@/pages/MyReferralsPage';
import ProjectRiskPage from '@/pages/ProjectRiskPage';
import ProjectRecordsPage from '@/pages/ProjectRecordsPage';
import ProjectChangeControlPage from '@/pages/ProjectChangeControlPage';
import ProjectProcurementPage from '@/pages/ProjectProcurementPage';
import ProjectResourcesPage from '@/pages/ProjectResourcesPage';
import ProjectQualityPage from '@/pages/ProjectQualityPage';
import ProjectEvmPage from '@/pages/ProjectEvmPage';
import ProjectCostPage from '@/pages/ProjectCostPage';
import ProjectWbsPage from '@/pages/ProjectWbsPage';
import AdminPage from '@/pages/AdminPage';
import ReportsPage from '@/pages/ReportsPage';
import WorkloadPage from '@/pages/WorkloadPage';
import DashboardsListPage from '@/pages/DashboardsListPage';
import DashboardEditorPage from '@/pages/DashboardEditorPage';
import SettingsLayout from '@/features/settings/SettingsLayout';
import DirectoriesPage from '@/pages/settings/DirectoriesPage';
import SecurityPage from '@/pages/settings/SecurityPage';
import AuditPage from '@/pages/settings/AuditPage';
import ApiWebhooksPage from '@/pages/settings/ApiWebhooksPage';
import PreferencesPage from '@/pages/settings/PreferencesPage';
import DateTimeSettingsPage from '@/pages/settings/DateTimeSettingsPage';
import RolesPage from '@/pages/settings/RolesPage';
import BackupsPage from '@/pages/settings/BackupsPage';
import TaskhubPage from '@/pages/settings/TaskhubPage';
import LabelsPage from '@/pages/settings/LabelsPage';
import CustomFieldsPage from '@/pages/settings/CustomFieldsPage';
import FormsListPage from '@/pages/settings/FormsListPage';
import CorrespondenceModulePage from '@/pages/settings/CorrespondenceModulePage';
import FormEditorPage from '@/pages/settings/FormEditorPage';
import FormSubmitPage from '@/pages/FormSubmitPage';
import PublicFormPage from '@/pages/PublicFormPage';
import AutomationsPage from '@/pages/settings/AutomationsPage';
import ProfilesPage from '@/pages/settings/ProfilesPage';
import PortfolioPage from '@/pages/PortfolioPage';
import TimesheetsPage from '@/pages/TimesheetsPage';
import SearchPage from '@/pages/SearchPage';
import HelpPage from '@/pages/HelpPage';
import AboutPage from '@/pages/AboutPage';
import CalendarPage from '@/pages/CalendarPage';
import TrashPage from '@/pages/TrashPage';
import PlannerLayout from '@/features/planner/PlannerLayout';
import PlannerBoardPage from '@/pages/planner/PlannerBoardPage';
import PlannerChartsPage from '@/pages/planner/PlannerChartsPage';
import PlannerGridPage from '@/pages/planner/PlannerGridPage';
import MyTasksPage from '@/pages/planner/MyTasksPage';
import ProtectedRoute from './ProtectedRoute';

export const router = createBrowserRouter([
  { path: '/', element: <Navigate to="/dashboard" replace /> },
  { path: '/login', element: <LoginPage /> },
  { path: '/public/forms/:token', element: <PublicFormPage /> },
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
      { path: '/portfolio', element: <PortfolioPage /> },
      { path: '/timesheets', element: <TimesheetsPage /> },
      { path: '/projects/:projectId/tasks', element: <TasksPage /> },
      { path: '/projects/:projectId/tasks/:taskId', element: <TaskDetailPage /> },
      // v1.42: per-project Gantt report.
      { path: '/projects/:projectId/reports/gantt', element: <ProjectGanttPage /> },
      // v1.81: per-project one-page status report.
      { path: '/projects/:projectId/reports/status', element: <ProjectStatusPage /> },
      // v1.89: per-project correspondence (دبیرخانه) register. Enabled per
      // project by a global admin; the page guards on the project being found.
      { path: '/projects/:projectId/correspondence', element: <CorrespondencePage /> },
      // v2.4 / v2.5 (PMIS R8 / R9): per-project registers.
      { path: '/projects/:projectId/records', element: <ProjectRecordsPage /> },
      { path: '/projects/:projectId/risks', element: <ProjectRiskPage /> },
      { path: '/projects/:projectId/change-control', element: <ProjectChangeControlPage /> },
      { path: '/projects/:projectId/procurement', element: <ProjectProcurementPage /> },
      { path: '/projects/:projectId/resources', element: <ProjectResourcesPage /> },
      { path: '/projects/:projectId/quality', element: <ProjectQualityPage /> },
      { path: '/projects/:projectId/evm', element: <ProjectEvmPage /> },
      { path: '/projects/:projectId/cost', element: <ProjectCostPage /> },
      { path: '/projects/:projectId/wbs', element: <ProjectWbsPage /> },
      { path: '/admin', element: <Navigate to="/settings/admin" replace /> },
      { path: '/me/referrals', element: <MyReferralsPage /> },
      { path: '/reports', element: <ReportsPage /> },
      { path: '/workload', element: <WorkloadPage /> },
      { path: '/dashboards', element: <DashboardsListPage /> },
      { path: '/dashboards/:dashboardId', element: <DashboardEditorPage /> },
      { path: '/forms/:formId', element: <FormSubmitPage /> },
      { path: '/calendar', element: <Navigate to="/planner/calendar" replace /> },
      {
        path: '/planner',
        element: <PlannerLayout />,
        children: [
          { index: true, element: <Navigate to="/planner/my-tasks" replace /> },
          { path: 'board', element: <PlannerBoardPage /> },
          { path: 'calendar', element: <CalendarPage /> },
          { path: 'charts', element: <PlannerChartsPage /> },
          { path: 'grid', element: <PlannerGridPage /> },
          { path: 'my-tasks', element: <MyTasksPage /> },
        ],
      },
      { path: '/trash', element: <Navigate to="/settings/trash" replace /> },
      { path: '/search', element: <SearchPage /> },
      { path: '/help', element: <HelpPage /> },
      { path: '/about', element: <AboutPage /> },
      {
        path: '/settings',
        element: <SettingsLayout />,
        children: [
          { path: 'preferences', element: <PreferencesPage /> },
          { path: 'date-time', element: <DateTimeSettingsPage /> },
          { path: 'roles', element: <RolesPage /> },
          { path: 'labels', element: <LabelsPage /> },
          { path: 'custom-fields', element: <CustomFieldsPage /> },
          { path: 'forms', element: <FormsListPage /> },
          { path: 'forms/:formId', element: <FormEditorPage /> },
          { path: 'correspondence', element: <CorrespondenceModulePage /> },
          { path: 'automations', element: <AutomationsPage /> },
          { path: 'profiles', element: <ProfilesPage /> },
          { path: 'directories', element: <DirectoriesPage /> },
          { path: 'taskhub', element: <TaskhubPage /> },
          { path: 'security', element: <SecurityPage /> },
          { path: 'audit', element: <AuditPage /> },
          { path: 'api', element: <ApiWebhooksPage /> },
          { path: 'backups', element: <BackupsPage /> },
          { path: 'trash', element: <TrashPage /> },
          { path: 'admin', element: <AdminPage /> },
        ],
      },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
]);

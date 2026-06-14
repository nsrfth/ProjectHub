import Fastify, { type FastifyInstance } from 'fastify';
import type { Env } from './config/env.js';
import { registerSecurity } from './plugins/security.js';
import { registerSwagger } from './plugins/swagger.js';
import { registerErrorHandler } from './middleware/errorHandler.js';
import { authRoutes } from './routes/auth.js';
import { teamsRoutes } from './routes/teams.js';
import { projectsCrossTeamRoutes, projectsRoutes } from './routes/projects.js';
import { ganttRoutes } from './routes/gantt.js';
import { tasksRoutes } from './routes/tasks.js';
import { commentsRoutes } from './routes/comments.js';
import { activityRoutes } from './routes/activity.js';
import { notificationsRoutes } from './routes/notifications.js';
import { adminRoutes } from './routes/admin.js';
import { labelsRoutes, taskLabelsRoutes } from './routes/labels.js';
import { subtasksRoutes } from './routes/subtasks.js';
import { attachmentsRoutes } from './routes/attachments.js';
import { notificationsWsRoutes } from './routes/notificationsWs.js';
import { reportsRoutes } from './routes/reports.js';
import { settingsRoutes } from './routes/settings.js';
import { directoriesRoutes } from './routes/directories.js';
import { scimRoutes } from './routes/scim.js';
import { auditRoutes } from './routes/audit.js';
import { apiTokensRoutes } from './routes/apiTokens.js';
import { webhooksRoutes } from './routes/webhooks.js';
import { recurrenceRoutes } from './routes/recurrence.js';
import { dependenciesRoutes } from './routes/dependencies.js';
import { searchRoutes } from './routes/search.js';
import { systemRoutes } from './routes/system.js';
import { calendarRoutes } from './routes/calendar.js';
import { trashRoutes } from './routes/trash.js';
import { rolesRoutes } from './routes/roles.js';
import { groupInvitesRoutes } from './routes/groupInvites.js';
import { userGroupsRoutes } from './routes/userGroups.js';
import { customFieldsRoutes, taskCustomFieldsRoutes } from './routes/customFields.js';
import { backupsRoutes } from './routes/backups.js';
import { taskhubRoutes } from './routes/taskhub.js';
import { securitySettingsRoutes } from './routes/securitySettings.js';
import { meTasksRoutes } from './routes/meTasks.js';
import { meProjectBucketsRoutes } from './routes/meProjectBuckets.js';
import { maintenanceGate } from './middleware/maintenance.js';
import { decorateLifecycle } from './lib/lifecycle.js';
import { prisma } from './data/prisma.js';

// App factory — separate from server.ts so tests can spin up the app without
// binding a port. Returns a ready-to-use Fastify instance.
export async function buildApp(env: Env): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === 'test' ? 'silent' : env.NODE_ENV === 'development' ? 'debug' : 'info',
      // Never log secrets or tokens. Add more redaction paths as new sensitive fields appear.
      redact: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.passwordHash'],
    },
    trustProxy: true, // Caddy sits in front.
    bodyLimit: 1 * 1024 * 1024, // 1 MiB for JSON. File uploads use multipart with its own limit.
  });

  await registerSwagger(app);
  await registerSecurity(app, env);
  registerErrorHandler(app);

  // SCIM clients (Okta, Azure AD) send Content-Type: application/scim+json
  // per RFC 7644 §3.1. Fastify only accepts application/json by default;
  // alias the SCIM mime type to the same parser so request bodies decode.
  app.addContentTypeParser(
    'application/scim+json',
    { parseAs: 'string' },
    (_req, body, done) => {
      try {
        done(null, body ? JSON.parse(body as string) : {});
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  app.get('/health', { schema: { tags: ['system'] } }, async () => ({ status: 'ok' }));

  // v1.30.4 (S-5): server-wide maintenance gate. Installed as an
  // onRequest hook — the earliest in Fastify's lifecycle — so it 503s
  // before content-type parsing or per-route preHandlers run. The hook
  // exempts /health and /api/health. The backup-restore flow flips the
  // InstanceSetting before pg_restore runs; the fresh boot after
  // restart clears it.
  app.addHook('onRequest', maintenanceGate);

  // v1.30.4 (S-5): decorate the app with a default no-op lifecycle so
  // tests / scripts that build the app without spinning up schedulers
  // don't see a missing-decorator error from the restore route.
  // server.ts overrides this with real scheduler stoppers + process.exit.
  decorateLifecycle(app, {
    stopBackground: () => undefined,
    processExit: (_code) => undefined,
  });

  await app.register(async (api) => {
    // Public health endpoint exposed under the /api prefix so Caddy can
    // proxy it from the public hostname. Same shape as /health. Exempt
    // from the v1.30.4 maintenance gate so admins can curl it during a
    // restore window to know when the new backend is up.
    api.get('/health', { schema: { tags: ['system'] } }, async () => ({ status: 'ok' }));
    await api.register(authRoutes, { prefix: '/auth', env });
    // Cross-project inbox — tasks assigned to the caller.
    await api.register(meTasksRoutes, { prefix: '/me' });
    await api.register(groupInvitesRoutes, { prefix: '/me/group-invites' });
    await api.register(meProjectBucketsRoutes, { prefix: '/me' });
    await api.register(teamsRoutes, { prefix: '/teams' });
    // Projects nest under teams so requireTeamRole picks up :teamId from the URL.
    await api.register(projectsRoutes, { prefix: '/teams/:teamId/projects' });
    // v1.40: cross-team list — same service, no :teamId in the URL.
    await api.register(projectsCrossTeamRoutes, { prefix: '/projects' });
    // Tasks nest under projects for the same reason — and to keep the URL
    // self-describing about the parent chain.
    await api.register(tasksRoutes, { prefix: '/teams/:teamId/projects/:projectId/tasks' });
    // Comments + activity nest under tasks. Each route's controller re-verifies
    // the team→project→task chain at the start so cross-tenant probes 404.
    await api.register(commentsRoutes, {
      prefix: '/teams/:teamId/projects/:projectId/tasks/:taskId/comments',
    });
    await api.register(activityRoutes, {
      prefix: '/teams/:teamId/projects/:projectId/tasks/:taskId/activity',
    });
    // Notifications are user-scoped — no team in the path.
    await api.register(notificationsRoutes, { prefix: '/notifications' });
    // Admin endpoints sit above team-level RBAC — gated by GlobalRole=ADMIN.
    await api.register(adminRoutes, { prefix: '/admin' });
    // v1.27: backup management — sits under /admin so it shares the
    // GlobalRole=ADMIN gate. Separate file so the route module stays small
    // and the BackupsService receives env (DATABASE_URL + BACKUP_DIR).
    await api.register(backupsRoutes, { prefix: '/admin/backups', env });
    // Labels live at the team scope; attach/detach lives under the task path.
    await api.register(labelsRoutes, { prefix: '/teams/:teamId/labels' });
    await api.register(taskLabelsRoutes, {
      prefix: '/teams/:teamId/projects/:projectId/tasks/:taskId/labels',
    });
    // Subtasks are children of one task; the task response already lists them.
    await api.register(subtasksRoutes, {
      prefix: '/teams/:teamId/projects/:projectId/tasks/:taskId/subtasks',
    });
    // Attachments are also task-scoped; the upload endpoint accepts multipart.
    await api.register(attachmentsRoutes, {
      prefix: '/teams/:teamId/projects/:projectId/tasks/:taskId/attachments',
      env,
    });
    // WebSocket realtime feed. Single endpoint under /api/ws/.
    await api.register(notificationsWsRoutes, { prefix: '/ws' });
    // Team-scoped reports (currently just "tasks done in last N days").
    await api.register(reportsRoutes, { prefix: '/teams/:teamId/reports' });

    await api.register(settingsRoutes, { prefix: '/settings' });
    await api.register(taskhubRoutes, { prefix: '/settings/taskhub' });
    await api.register(securitySettingsRoutes, { prefix: '/settings/security' });

    await api.register(directoriesRoutes, { prefix: '/settings/directories' });

    // SCIM 2.0. Registered as its own encapsulated child so the route-scoped
    // error handler (SCIM-shaped error envelope) doesn't leak to other paths.
    await api.register(scimRoutes, { prefix: '/scim/v2' });

    await api.register(auditRoutes, { prefix: '/audit' });

    await api.register(apiTokensRoutes, { prefix: '/settings/api-tokens' });
    await api.register(webhooksRoutes, { prefix: '/teams/:teamId/webhooks' });
    await api.register(recurrenceRoutes, {
      prefix: '/teams/:teamId/projects/:projectId/tasks/:taskId/recurrence',
    });
    // v1.29: task dependency edges. Same nesting as recurrence so the
    // requireTeamRole gate carries through; per-route requirePermission
    // gates write endpoints with `task.manage_dependencies`.
    await api.register(dependenciesRoutes, {
      prefix: '/teams/:teamId/projects/:projectId/tasks/:taskId/dependencies',
    });
    // v1.42: project Gantt report. Per-project read-only aggregator —
    // every subtask grouped by parent task with summary counters.
    await api.register(ganttRoutes, {
      prefix: '/teams/:teamId/projects/:projectId/reports/gantt',
    });
    // v1.30: cross-team full-text search. Top-level mount — the endpoint
    // spans every team the caller is a member of, so it isn't nested
    // under /teams/:teamId like most read endpoints.
    await api.register(searchRoutes, { prefix: '/search' });

    // v1.11: public read-only system info. No auth, no rate limit — used
    // by the About page + the calendar weekend reader.
    await api.register(systemRoutes, { prefix: '/system' });

    // v1.12: team-scoped cross-project calendar feed.
    await api.register(calendarRoutes, { prefix: '/teams/:teamId/calendar' });

    // v1.21: soft-delete trash. List + restore for any team member; purge +
    // empty gated by the per-instance trash.emptyAllowedRoles setting.
    await api.register(trashRoutes, { prefix: '/teams/:teamId/trash' });

    // v1.23: per-team custom roles + permission matrix. Listing is open
    // to any team member; mutations gated by team.manage_roles.
    await api.register(rolesRoutes, { prefix: '/teams/:teamId/roles' });
    // v1.50: team user groups for project access grants.
    await api.register(userGroupsRoutes, { prefix: '/teams/:teamId/groups' });
    // v1.58: team-scoped custom field definitions + per-task typed values.
    await api.register(customFieldsRoutes, { prefix: '/teams/:teamId/custom-fields' });
    await api.register(taskCustomFieldsRoutes, {
      prefix: '/teams/:teamId/projects/:projectId/tasks/:taskId/custom-fields',
    });
  }, { prefix: '/api' });

  app.addHook('onClose', async () => {
    await prisma.$disconnect();
  });

  return app;
}

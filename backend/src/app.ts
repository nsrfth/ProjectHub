import Fastify, { type FastifyInstance } from 'fastify';
import type { Env } from './config/env.js';
import { registerSecurity } from './plugins/security.js';
import { registerSwagger } from './plugins/swagger.js';
import { registerErrorHandler } from './middleware/errorHandler.js';
import { authRoutes } from './routes/auth.js';
import { teamsRoutes } from './routes/teams.js';
import { projectsRoutes } from './routes/projects.js';
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

  app.get('/health', { schema: { tags: ['system'] } }, async () => ({ status: 'ok' }));

  await app.register(async (api) => {
    await api.register(authRoutes, { prefix: '/auth', env });
    await api.register(teamsRoutes, { prefix: '/teams' });
    // Projects nest under teams so requireTeamRole picks up :teamId from the URL.
    await api.register(projectsRoutes, { prefix: '/teams/:teamId/projects' });
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
  }, { prefix: '/api' });

  app.addHook('onClose', async () => {
    await prisma.$disconnect();
  });

  return app;
}

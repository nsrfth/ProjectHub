import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AdminService } from '../services/adminService.js';
import { AdminController } from '../controllers/adminController.js';
import { requireAuth, requireGlobalRole } from '../middleware/auth.js';
import { requireScope } from '../middleware/requireScope.js';
import { updateCheckService } from '../services/updateCheckService.js';
import {
  adminResetPasswordBody,
  adminResetPasswordResponse,
  adminUserResponse,
  createUserBody,
  createUserResponse,
  listQuery,
  teamsPage,
  updateUserRoleBody,
  usersPage,
} from '../schemas/admin.js';

// Admin endpoints are gated by GlobalRole=ADMIN. There is no team-level RBAC
// here; an admin operates above the tenant boundary by definition.
export async function adminRoutes(app: FastifyInstance): Promise<void> {
  const svc = new AdminService();
  const ctrl = new AdminController(svc);
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireGlobalRole('ADMIN'));
  // v1.30.3 (S-2): admin routes additionally require the `admin` scope on
  // API tokens. Sessions pass implicitly (no token scopes attached).
  r.addHook('preHandler', requireScope('admin'));

  r.get('/users', {
    schema: {
      tags: ['admin'],
      summary: 'List users (ADMIN only) — cursor pagination',
      querystring: listQuery,
      response: { 200: usersPage },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.listUsers,
  });

  // v1.26: admin-driven user provisioning. Admin types email + name and
  // either a password OR omits it for the server to generate one. The
  // response surfaces the generated password ONCE so the admin can hand it
  // over; we never log it.
  r.post('/users', {
    schema: {
      tags: ['admin'],
      summary:
        'Create a user with credentials (ADMIN only). Server-generated password returned once when not supplied.',
      body: createUserBody,
      response: { 201: createUserResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.createUser,
  });

  r.patch('/users/:userId', {
    schema: {
      tags: ['admin'],
      summary: 'Change a user\'s global role (ADMIN only; cannot demote last admin or self)',
      params: z.object({ userId: z.string() }),
      body: updateUserRoleBody,
      response: { 200: adminUserResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.updateUserRole,
  });

  // v1.32.0: admin-initiated password reset. Caller may supply a password
  // (validated by passwordSchema) or omit it for a server-generated value
  // returned once. Directory-owned (LDAP/SCIM) targets are rejected with
  // 409 — their password lives in the directory.
  r.post('/users/:userId/password', {
    schema: {
      tags: ['admin'],
      summary:
        "Reset a user's password (ADMIN only). Generates one when omitted; refuses directory-owned accounts.",
      params: z.object({ userId: z.string() }),
      body: adminResetPasswordBody,
      response: { 200: adminResetPasswordResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.resetUserPassword,
  });

  r.get('/teams', {
    schema: {
      tags: ['admin'],
      summary: 'List teams (ADMIN only) — cursor pagination',
      querystring: listQuery,
      response: { 200: teamsPage },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.listTeams,
  });

  r.delete('/teams/:teamId', {
    schema: {
      tags: ['admin'],
      summary: 'Delete a team and all of its content (ADMIN only; cascades)',
      params: z.object({ teamId: z.string() }),
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.deleteTeam,
  });

  r.delete('/users/:userId', {
    schema: {
      tags: ['admin'],
      summary:
        'Delete a user account. Project.owner / Task.creator / Task.assignee / Comment.author SetNull; activities + attachments + memberships cascade-delete. Cannot delete self or last ADMIN.',
      params: z.object({ userId: z.string() }),
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.deleteUser,
  });

  // v1.22: trigger an in-app self-upgrade. Disabled (503) when UPDATER_URL is
  // unset — the standard config. When enabled, this POSTs to the privileged
  // updater sidecar which runs `git pull && docker compose up -d --build` in
  // a detached process. The mid-upgrade UX is the SPA's problem: it polls
  // /api/health and reloads when the new backend is up.
  r.post('/upgrade', {
    schema: {
      tags: ['admin'],
      summary:
        'Trigger an in-app self-upgrade via the updater sidecar (admin-only). Returns 503 when the sidecar is not configured.',
      response: {
        202: z.object({ status: z.string(), startedAt: z.string() }),
        503: z.object({ error: z.object({ code: z.string(), message: z.string() }) }),
      },
      security: [{ bearerAuth: [] }],
    },
    handler: async (_req, reply) => {
      const url = process.env.UPDATER_URL;
      const token = process.env.UPDATER_TOKEN ?? '';
      if (!url) {
        return reply.status(503).send({
          error: {
            code: 'UPDATER_DISABLED',
            message:
              'In-app upgrade is not configured. The operator must add the `updater` sidecar and set UPDATER_URL + UPDATER_TOKEN. See UPGRADE.md.',
          },
        });
      }
      // Fire-and-forget — the updater returns 202 immediately and the
      // upgrade continues in a detached child process there. 10s timeout
      // because the network call itself is local-only.
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 10_000);
      try {
        const res = await fetch(`${url.replace(/\/$/, '')}/upgrade`, {
          method: 'POST',
          headers: token ? { 'X-Updater-Token': token } : {},
          signal: ac.signal,
        });
        const body = (await res.json().catch(() => null)) as
          | { status?: string; startedAt?: string }
          | null;
        if (!res.ok) {
          return reply.status(503).send({
            error: {
              code: 'UPDATER_REJECTED',
              message: `Updater returned ${res.status}`,
            },
          });
        }
        return reply.status(202).send({
          status: body?.status ?? 'started',
          startedAt: body?.startedAt ?? new Date().toISOString(),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'network error';
        return reply.status(503).send({
          error: { code: 'UPDATER_UNREACHABLE', message: msg },
        });
      } finally {
        clearTimeout(timer);
      }
    },
  });

  // v1.16: opt-in "update available" check. Disabled by default — the
  // backend only contacts GitHub when the operator sets UPDATE_CHECK_ENABLED.
  // Admin-only because the badge only matters to people who can actually
  // upgrade the deployment.
  r.get('/update-check', {
    schema: {
      tags: ['admin'],
      summary:
        'Check whether a newer TaskHub release exists on GitHub (cached). Returns enabled=false when UPDATE_CHECK_ENABLED is not set.',
      response: {
        200: z.object({
          currentVersion: z.string(),
          enabled: z.boolean(),
          latestVersion: z.string().nullable(),
          updateAvailable: z.boolean(),
          releaseUrl: z.string().nullable(),
          publishedAt: z.string().nullable(),
          checkedAt: z.string().nullable(),
        }),
      },
      security: [{ bearerAuth: [] }],
    },
    handler: async (_req, reply) => reply.send(await updateCheckService.getStatus()),
  });
}

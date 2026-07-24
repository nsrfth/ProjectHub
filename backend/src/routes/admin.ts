import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AdminService } from '../services/adminService.js';
import { AdminController } from '../controllers/adminController.js';
import { AuthService } from '../services/authService.js';
import { loadEnv } from '../config/env.js';
import { requireAuth, requireGlobalRole } from '../middleware/auth.js';
import { requireScope } from '../middleware/requireScope.js';
import { updateCheckService } from '../services/updateCheckService.js';
import { AssignmentRequestsService } from '../services/assignmentRequestsService.js';
import { assignmentApprovalView } from '../schemas/assignmentRequests.js';
import { escapeField } from '../lib/csv.js';
import {
  adminResetPasswordBody,
  adminResetPasswordResponse,
  adminUserResponse,
  createUserBody,
  createUserResponse,
  ldapSyncResponse,
  ldapTestAuthBody,
  ldapTestAuthResponse,
  listQuery,
  listUsersQuery,
  setUserDisabledBody,
  teamsPage,
  updateUserProfileBody,
  updateUserRoleBody,
  usersPage,
  departmentsList,
  projectDepartmentsList,
  transferDepartmentBody,
  transferDepartmentResult,
} from '../schemas/admin.js';

// Admin endpoints are gated by GlobalRole=ADMIN. There is no team-level RBAC
// here; an admin operates above the tenant boundary by definition.
export async function adminRoutes(app: FastifyInstance): Promise<void> {
  const env = loadEnv();
  const svc = new AdminService();
  const authSvc = new AuthService(env, {
    signAccess: (p) => app.signAccess(p as Parameters<typeof app.signAccess>[0]),
    signRefresh: (p, exp) => app.signRefresh(p, exp),
    verifyRefresh: (t) => app.verifyRefresh(t),
    signPending: (sub) => app.signPending(sub),
    verifyPending: (t) => app.verifyPending(t),
  });
  const ctrl = new AdminController(svc, authSvc);
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireGlobalRole('ADMIN'));
  // v1.30.3 (S-2): admin routes additionally require the `admin` scope on
  // API tokens. Sessions pass implicitly (no token scopes attached).
  r.addHook('preHandler', requireScope('admin'));

  // v2.8 (Phase 2): the ISO 27001 A.5.18 access-review artifact — every
  // project-access grant as CSV, one row per grant, with resolved names so a
  // reviewer doesn't need database access to read it. Streams as a download.
  // The quarterly review procedure (Phase 6 doc) is built around this export.
  // v-next (P3): cross-unit assignment-request oversight for admins.
  r.get('/assignment-requests', {
    schema: {
      tags: ['admin'],
      summary: 'Cross-unit assignment requests (pending/expired/all) for oversight',
      querystring: z.object({ scope: z.enum(['pending', 'expired', 'all']).default('pending') }),
      response: { 200: z.object({ items: z.array(assignmentApprovalView) }) },
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      const svc = new AssignmentRequestsService();
      const { scope } = req.query as { scope: 'pending' | 'expired' | 'all' };
      return reply.send({ items: await svc.listForAdmin(scope) });
    },
  });

  r.get('/access-report', {
    schema: {
      tags: ['admin'],
      summary: 'Export all project-access grants as CSV (ISO A.5.18 evidence)',
      security: [{ bearerAuth: [] }],
    },
    handler: async (_req, reply) => {
      const { prisma } = await import('../data/prisma.js');
      const rows = await prisma.projectAccessGrant.findMany({
        include: {
          project: { select: { name: true, team: { select: { name: true } } } },
          grantedBy: { select: { email: true } },
        },
        orderBy: [{ projectId: 'asc' }, { grantedAt: 'asc' }],
      });
      // Resolve subject names in bulk — one query per subject type, not per row.
      const ids = (t: string) => [...new Set(rows.filter((r) => r.subjectType === t).map((r) => r.subjectId))];
      const [users, groups, teams] = await Promise.all([
        prisma.user.findMany({ where: { id: { in: ids('USER') } }, select: { id: true, email: true } }),
        prisma.userGroup.findMany({ where: { id: { in: ids('GROUP') } }, select: { id: true, name: true, kind: true } }),
        prisma.team.findMany({ where: { id: { in: ids('TEAM') } }, select: { id: true, name: true } }),
      ]);
      const nameOf = new Map<string, string>([
        ...users.map((u) => [u.id, u.email] as const),
        ...groups.map((g) => [g.id, `${g.name} (${g.kind})`] as const),
        ...teams.map((t) => [t.id, t.name] as const),
      ]);
      // Use the shared CSV field escaper: it quotes commas/quotes/newlines AND
      // neutralizes leading formula characters (= + - @) so a project/team name
      // or email set by a lower-privileged member can't execute as a spreadsheet
      // formula when an admin opens the export.
      const esc = (v: string | null | undefined) => escapeField(v ?? '');
      const mode = loadEnv().ACCESS_UNIFIED_GRANTS;
      const header =
        `# TaskHub access report, generated ${new Date().toISOString()}, ACCESS_UNIFIED_GRANTS=${mode}\n` +
        (mode !== 'on'
          ? '# NOTE: legacy tables are still authoritative in this mode; grants marked source=legacy:* mirror them.\n'
          : '') +
        'team,project,subjectType,subject,level,status,source,grantedBy,grantedAt,expiresAt\n';
      const body = rows
        .map((r) =>
          [
            esc(r.project.team.name), esc(r.project.name), r.subjectType,
            esc(nameOf.get(r.subjectId) ?? r.subjectId), r.level, r.status,
            esc(r.source), esc(r.grantedBy?.email ?? '(system)'),
            r.grantedAt.toISOString(), r.expiresAt?.toISOString() ?? '',
          ].join(','),
        )
        .join('\n');
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="access-report-${Date.now()}.csv"`)
        .send(header + body + '\n');
    },
  });

  r.get('/users', {
    schema: {
      tags: ['admin'],
      summary:
        'List users (ADMIN only) — search, filter, sort, offset pagination with total count',
      querystring: listUsersQuery,
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
  r.post('/users/:userId/ldap/sync', {
    schema: {
      tags: ['admin'],
      summary: 'Refresh an LDAP user profile from the directory (ADMIN only)',
      params: z.object({ userId: z.string() }),
      response: { 200: ldapSyncResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.refreshLdapUser,
  });

  r.post('/users/:userId/ldap/test-auth', {
    schema: {
      tags: ['admin'],
      summary: 'Test LDAP credentials for a user (password is not stored)',
      params: z.object({ userId: z.string() }),
      body: ldapTestAuthBody,
      response: { 200: ldapTestAuthResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.testLdapUserAuth,
  });

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

  r.post('/users/:userId/disable', {
    schema: {
      tags: ['admin'],
      summary: 'Disable or enable a user (ADMIN only). Disabling revokes all refresh tokens.',
      params: z.object({ userId: z.string() }),
      body: setUserDisabledBody,
      response: { 200: adminUserResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.setUserDisabled,
  });

  r.post('/users/:userId/unlock', {
    schema: {
      tags: ['admin'],
      summary: 'Clear account lockout (ADMIN only)',
      params: z.object({ userId: z.string() }),
      response: { 200: adminUserResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.unlockUser,
  });

  r.post('/users/:userId/force-logout', {
    schema: {
      tags: ['admin'],
      summary: 'Revoke all active sessions without disabling the account (ADMIN only)',
      params: z.object({ userId: z.string() }),
      response: { 200: adminUserResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.forceLogoutUser,
  });

  r.patch('/users/:userId/profile', {
    schema: {
      tags: ['admin'],
      summary: 'Edit a local user profile (ADMIN only). Directory-owned accounts rejected.',
      params: z.object({ userId: z.string() }),
      body: updateUserProfileBody,
      response: { 200: adminUserResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.updateUserProfile,
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

  // v2.19: project ↔ department administration. A project's "department" is its
  // GROUP-subject ProjectAccessGrant whose group is a UNIT; transferring creates
  // the target department's grant (imposed ACTIVE for an admin) and revokes the
  // prior one, dual-writing the legacy row throughout. Tenancy is unchanged.
  r.get('/departments', {
    schema: {
      tags: ['admin'],
      summary: 'List all departments (UNIT user-groups) across divisions (ADMIN only)',
      response: { 200: departmentsList },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.listDepartments,
  });

  r.get('/project-departments', {
    schema: {
      tags: ['admin'],
      summary: 'List every project with its current department (ADMIN only)',
      response: { 200: projectDepartmentsList },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.listProjectDepartments,
  });

  r.post('/projects/:projectId/transfer-department', {
    schema: {
      tags: ['admin'],
      summary: 'Transfer a project to a different department (ADMIN only)',
      params: z.object({ projectId: z.string() }),
      body: transferDepartmentBody,
      response: { 200: transferDepartmentResult },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.transferProjectDepartment,
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

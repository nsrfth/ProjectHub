import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { TaskAssignmentRequest } from '@prisma/client';
import { z } from 'zod';
import { requireAuth, requireTeamRoleOrGrantedProject } from '../middleware/auth.js';
import { requireProjectAccess, requireProjectWriteAccess } from '../middleware/requireProjectAccess.js';
import { requireScope } from '../middleware/requireScope.js';
import { Errors } from '../lib/errors.js';
import { AssignmentRequestsService } from '../services/assignmentRequestsService.js';
import {
  createAssignmentRequestBody,
  assignAssignmentRequestBody,
  forwardAssignmentRequestBody,
  declineAssignmentRequestBody,
  assignmentRequestResponse,
  assignmentApprovalsResponse,
} from '../schemas/assignmentRequests.js';

const svc = new AssignmentRequestsService();

/** Prisma Date fields → ISO strings (codebase output convention). */
function view(r: TaskAssignmentRequest) {
  return {
    ...r,
    expiresAt: r.expiresAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
  };
}

// v-next Slice 5 — request CREATION. Mounted UNDER the task router at
// /teams/:teamId/projects/:projectId/tasks/:taskId/assignment-requests. The
// requester has project access by definition, so the standard task-sub hooks
// (incl. requireProjectAccess) are correct here — unlike the decision router.
export async function taskAssignmentRequestsRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireTeamRoleOrGrantedProject('MEMBER', 'MANAGER'));
  r.addHook('preHandler', requireProjectAccess());

  r.post('/', {
    preHandler: [requireProjectWriteAccess(), requireScope('tasks:write')],
    schema: {
      tags: ['assignment-requests'],
      summary: 'Request assignment of this task to someone outside your unit',
      params: z.object({ teamId: z.string(), projectId: z.string(), taskId: z.string() }),
      body: createAssignmentRequestBody,
      response: { 201: assignmentRequestResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      if (!req.user) throw Errors.unauthorized();
      const { teamId, projectId, taskId } = req.params as {
        teamId: string;
        projectId: string;
        taskId: string;
      };
      const body = req.body as { proposedId: string };
      const out = await svc.create(teamId, projectId, taskId, req.user.sub, body);
      return reply.code(201).send(view(out));
    },
  });
}

// v-next Slice 5 — DECISIONS + INBOX. Mounted at /me/assignment-approvals with
// NO project-access hook: a cross-division approver has no access to the
// project the task lives in (the correspondence v2.5.33 lesson). The service is
// the gate — it resolves whether the caller is the request's approver /
// forwarded manager and 404s otherwise, so request existence never leaks.
export async function meAssignmentApprovalsRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook('preHandler', requireAuth);

  const idParams = z.object({ reqId: z.string() });

  r.get('/', {
    preHandler: [requireScope('tasks:read')],
    schema: {
      tags: ['me'],
      summary: 'Assignment requests awaiting my decision, across all teams',
      response: { 200: assignmentApprovalsResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      if (!req.user) throw Errors.unauthorized();
      const items = await svc.listMyApprovals(req.user.sub);
      return reply.send({ items: items.map(view) });
    },
  });

  r.post('/:reqId/approve', {
    preHandler: [requireScope('tasks:write')],
    schema: {
      tags: ['me'],
      summary: 'Approve an assignment request',
      params: idParams,
      response: { 200: assignmentRequestResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      if (!req.user) throw Errors.unauthorized();
      const { reqId } = req.params as { reqId: string };
      return reply.send(view(await svc.approve(reqId, req.user.sub)));
    },
  });

  r.post('/:reqId/forward', {
    preHandler: [requireScope('tasks:write')],
    schema: {
      tags: ['me'],
      summary: 'Forward a cross-division request to a department manager (ابلاغ)',
      params: idParams,
      body: forwardAssignmentRequestBody,
      response: { 200: assignmentRequestResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      if (!req.user) throw Errors.unauthorized();
      const { reqId } = req.params as { reqId: string };
      const { toDeptManagerId } = req.body as { toDeptManagerId: string };
      return reply.send(view(await svc.forward(reqId, req.user.sub, toDeptManagerId)));
    },
  });

  r.post('/:reqId/assign', {
    preHandler: [requireScope('tasks:write')],
    schema: {
      tags: ['me'],
      summary: 'Select the final assignee (terminal)',
      params: idParams,
      body: assignAssignmentRequestBody,
      response: { 200: assignmentRequestResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      if (!req.user) throw Errors.unauthorized();
      const { reqId } = req.params as { reqId: string };
      const { assigneeId } = req.body as { assigneeId: string };
      return reply.send(view(await svc.assign(reqId, req.user.sub, assigneeId)));
    },
  });

  r.post('/:reqId/decline', {
    preHandler: [requireScope('tasks:write')],
    schema: {
      tags: ['me'],
      summary: 'Decline an assignment request (reason required)',
      params: idParams,
      body: declineAssignmentRequestBody,
      response: { 200: assignmentRequestResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      if (!req.user) throw Errors.unauthorized();
      const { reqId } = req.params as { reqId: string };
      const { reason } = req.body as { reason: string };
      return reply.send(view(await svc.decline(reqId, req.user.sub, reason)));
    },
  });
}

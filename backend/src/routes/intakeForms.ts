import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import {
  IntakeFormsController,
  PublicIntakeFormsController,
} from '../controllers/intakeFormsController.js';
import { requireAuth, requireTeamRole } from '../middleware/auth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { requireScope } from '../middleware/requireScope.js';
import type { Env } from '../config/env.js';
import {
  createIntakeFormBody,
  intakeFormResponse,
  intakeFormsListResponse,
  intakeFormSubmitBody,
  intakeFormSubmitResponse,
  intakeFormSubmitTeamResponse,
  publicIntakeFormRenderResponse,
  updateIntakeFormBody,
  type CreateIntakeFormBody,
  type IntakeFormSubmitBody,
  type UpdateIntakeFormBody,
} from '../schemas/intakeForms.js';

type TeamParams = { teamId: string };
type FormParams = { teamId: string; formId: string };

export async function intakeFormsRoutes(app: FastifyInstance): Promise<void> {
  const ctrl = new IntakeFormsController();
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireTeamRole('MEMBER', 'MANAGER'));

  r.get('/', {
    preHandler: requireScope('projects:read'),
    schema: {
      tags: ['intake-forms'],
      summary: 'List intake forms (enabled only for members; all for form managers)',
      params: z.object({ teamId: z.string() }),
      response: { 200: intakeFormsListResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.list,
  });

  r.get('/:formId', {
    preHandler: requireScope('projects:read'),
    schema: {
      tags: ['intake-forms'],
      summary: 'Get intake form definition for rendering or editing',
      params: z.object({ teamId: z.string(), formId: z.string() }),
      response: { 200: intakeFormResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.get,
  });

  r.post('/', {
    preHandler: [requirePermission('form.manage'), requireScope('admin')],
    schema: {
      tags: ['intake-forms'],
      summary: 'Create an intake form',
      params: z.object({ teamId: z.string() }),
      body: createIntakeFormBody,
      response: { 201: intakeFormResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (
      req: FastifyRequest<{ Params: TeamParams; Body: CreateIntakeFormBody }>,
      reply: FastifyReply,
    ) => ctrl.create(req, reply),
  });

  r.patch('/:formId', {
    preHandler: [requirePermission('form.manage'), requireScope('admin')],
    schema: {
      tags: ['intake-forms'],
      summary: 'Update an intake form',
      params: z.object({ teamId: z.string(), formId: z.string() }),
      body: updateIntakeFormBody,
      response: { 200: intakeFormResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (
      req: FastifyRequest<{ Params: FormParams; Body: UpdateIntakeFormBody }>,
      reply: FastifyReply,
    ) => ctrl.update(req, reply),
  });

  r.delete('/:formId', {
    preHandler: [requirePermission('form.manage'), requireScope('admin')],
    schema: {
      tags: ['intake-forms'],
      summary: 'Delete an intake form',
      params: z.object({ teamId: z.string(), formId: z.string() }),
      response: { 204: z.null() },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.remove,
  });

  r.post('/:formId/rotate-token', {
    preHandler: [requirePermission('form.manage'), requireScope('admin')],
    schema: {
      tags: ['intake-forms'],
      summary: 'Rotate the public submission token (invalidates the old URL)',
      params: z.object({ teamId: z.string(), formId: z.string() }),
      response: { 200: intakeFormResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.rotateToken,
  });

  r.post('/:formId/submit', {
    preHandler: requireScope('tasks:write'),
    schema: {
      tags: ['intake-forms'],
      summary: 'Submit an intake form (authenticated team member)',
      params: z.object({ teamId: z.string(), formId: z.string() }),
      body: intakeFormSubmitBody,
      response: { 200: intakeFormSubmitTeamResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: async (
      req: FastifyRequest<{ Params: FormParams; Body: IntakeFormSubmitBody }>,
      reply: FastifyReply,
    ) => ctrl.submit(req, reply),
  });
}

export async function publicIntakeFormsRoutes(app: FastifyInstance, opts: { env: Env }): Promise<void> {
  const ctrl = new PublicIntakeFormsController();

  // Scoped rate limit for unauthenticated intake — separate from auth limits.
  await app.register(rateLimit, {
    global: true,
    max: opts.env.PUBLIC_FORM_RATE_LIMIT_MAX,
    timeWindow: opts.env.PUBLIC_FORM_RATE_LIMIT_WINDOW,
  });

  const r = app.withTypeProvider<ZodTypeProvider>();

  // v1.69 (S-9 mirror): unauthenticated public intake — opaque token only,
  // rate-limited, honeypot on submit, minimal render payload.

  r.get('/:publicToken', {
    schema: {
      tags: ['intake-forms-public'],
      summary: 'Render a public intake form (fields only — no team data)',
      params: z.object({ publicToken: z.string() }),
      response: { 200: publicIntakeFormRenderResponse },
    },
    handler: ctrl.get,
  });

  r.post('/:publicToken/submit', {
    schema: {
      tags: ['intake-forms-public'],
      summary: 'Submit a public intake form (unauthenticated)',
      params: z.object({ publicToken: z.string() }),
      body: intakeFormSubmitBody,
      response: { 200: intakeFormSubmitResponse },
    },
    handler: async (
      req: FastifyRequest<{ Params: { publicToken: string }; Body: IntakeFormSubmitBody }>,
      reply: FastifyReply,
    ) => ctrl.submit(req, reply),
  });
}

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Env } from '../config/env.js';
import { IntakeFormsService, publicFormUrl } from '../services/intakeFormsService.js';
import { hasPermission } from '../middleware/requirePermission.js';
import { Errors } from '../lib/errors.js';
import type {
  CreateIntakeFormBody,
  IntakeFormSubmitBody,
  UpdateIntakeFormBody,
} from '../schemas/intakeForms.js';

type TeamParams = { teamId: string };
type FormParams = { teamId: string; formId: string };

function serializeForm(view: Awaited<ReturnType<IntakeFormsService['get']>>) {
  return {
    ...view,
    createdAt: view.createdAt.toISOString(),
    updatedAt: view.updatedAt.toISOString(),
    publicUrl: view.publicToken ? publicFormUrl(view.publicToken) : null,
  };
}

export class IntakeFormsController {
  constructor(private svc = new IntakeFormsService()) {}

  list = async (req: FastifyRequest<{ Params: TeamParams }>, reply: FastifyReply) => {
    if (!req.user) throw Errors.unauthorized();
    const canManage = await hasPermission(req, 'form.manage');
    const items = await this.svc.list(req.params.teamId, canManage);
    return reply.send({
      items: items.map((f) => ({
        id: f.id,
        teamId: f.teamId,
        projectId: f.projectId,
        name: f.name,
        description: f.description,
        mode: f.mode,
        enabled: f.enabled,
        fieldCount: f.fields.length,
        createdAt: f.createdAt.toISOString(),
        updatedAt: f.updatedAt.toISOString(),
      })),
    });
  };

  get = async (req: FastifyRequest<{ Params: FormParams }>, reply: FastifyReply) => {
    const form = await this.svc.get(req.params.teamId, req.params.formId);
    return reply.send(serializeForm(form));
  };

  create = async (
    req: FastifyRequest<{ Params: TeamParams; Body: CreateIntakeFormBody }>,
    reply: FastifyReply,
  ) => {
    if (!req.user) throw Errors.unauthorized();
    const form = await this.svc.create(req.params.teamId, req.user.sub, req.body);
    return reply.status(201).send(serializeForm(form));
  };

  update = async (
    req: FastifyRequest<{ Params: FormParams; Body: UpdateIntakeFormBody }>,
    reply: FastifyReply,
  ) => {
    const form = await this.svc.update(req.params.teamId, req.params.formId, req.body);
    return reply.send(serializeForm(form));
  };

  remove = async (req: FastifyRequest<{ Params: FormParams }>, reply: FastifyReply) => {
    await this.svc.remove(req.params.teamId, req.params.formId);
    return reply.status(204).send();
  };

  rotateToken = async (req: FastifyRequest<{ Params: FormParams }>, reply: FastifyReply) => {
    const form = await this.svc.rotatePublicToken(req.params.teamId, req.params.formId);
    return reply.send(serializeForm(form));
  };

  submit = async (
    req: FastifyRequest<{ Params: FormParams; Body: IntakeFormSubmitBody }>,
    reply: FastifyReply,
  ) => {
    if (!req.user) throw Errors.unauthorized();
    const result = await this.svc.submitTeam(
      req.params.teamId,
      req.params.formId,
      req.user.sub,
      req.user.globalRole,
      req.body,
    );
    return reply.send({ success: true as const, taskId: result.taskId });
  };
}

export class PublicIntakeFormsController {
  constructor(private svc = new IntakeFormsService()) {}

  get = async (req: FastifyRequest<{ Params: { publicToken: string } }>, reply: FastifyReply) => {
    const form = await this.svc.getByPublicToken(req.params.publicToken);
    return reply.send(form);
  };

  submit = async (
    req: FastifyRequest<{ Params: { publicToken: string }; Body: IntakeFormSubmitBody }>,
    reply: FastifyReply,
  ) => {
    await this.svc.submitPublic(req.params.publicToken, req.body);
    return reply.send({ success: true as const });
  };
}

export function publicFormRateLimit(env: Env) {
  return {
    rateLimit: {
      max: env.PUBLIC_FORM_RATE_LIMIT_MAX,
      timeWindow: env.PUBLIC_FORM_RATE_LIMIT_WINDOW,
    },
  } as const;
}

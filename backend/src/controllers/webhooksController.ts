import type { FastifyReply, FastifyRequest } from 'fastify';
import type { WebhookService } from '../services/webhookService.js';
import type {
  WebhookCreateBody,
  WebhookUpdateBody,
  WebhookDeliveryQuery,
} from '../schemas/webhooks.js';

type TeamParams = { teamId: string };
type IdParams = { teamId: string; webhookId: string };

function serialise(w: {
  id: string;
  teamId: string;
  name: string;
  url: string;
  events: string[];
  active: boolean;
  hasSecret: boolean;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    ...w,
    createdAt: w.createdAt.toISOString(),
    updatedAt: w.updatedAt.toISOString(),
  };
}

function serialiseDelivery(d: {
  id: string;
  webhookId: string;
  eventType: string;
  payload: unknown;
  status: 'PENDING' | 'DELIVERED' | 'FAILED';
  attempt: number;
  maxAttempts: number;
  httpStatus: number | null;
  errorMessage: string | null;
  nextAttemptAt: Date;
  deliveredAt: Date | null;
  createdAt: Date;
}) {
  return {
    ...d,
    nextAttemptAt: d.nextAttemptAt.toISOString(),
    deliveredAt: d.deliveredAt?.toISOString() ?? null,
    createdAt: d.createdAt.toISOString(),
  };
}

export class WebhooksController {
  constructor(private readonly svc: WebhookService) {}

  list = async (req: FastifyRequest<{ Params: TeamParams }>, reply: FastifyReply) => {
    const items = await this.svc.list(req.params.teamId);
    return reply.send({ items: items.map(serialise) });
  };

  create = async (
    req: FastifyRequest<{ Params: TeamParams; Body: WebhookCreateBody }>,
    reply: FastifyReply,
  ) => {
    const { view, rawSecret } = await this.svc.create(req.params.teamId, req.body);
    return reply.code(201).send({ ...serialise(view), rawSecret });
  };

  update = async (
    req: FastifyRequest<{ Params: IdParams; Body: WebhookUpdateBody }>,
    reply: FastifyReply,
  ) => {
    const view = await this.svc.update(req.params.teamId, req.params.webhookId, req.body);
    return reply.send(serialise(view));
  };

  remove = async (req: FastifyRequest<{ Params: IdParams }>, reply: FastifyReply) => {
    await this.svc.delete(req.params.teamId, req.params.webhookId);
    return reply.code(204).send();
  };

  testSend = async (req: FastifyRequest<{ Params: IdParams }>, reply: FastifyReply) => {
    const result = await this.svc.testSend(req.params.teamId, req.params.webhookId);
    return reply.send(result);
  };

  listDeliveries = async (
    req: FastifyRequest<{ Params: IdParams; Querystring: WebhookDeliveryQuery }>,
    reply: FastifyReply,
  ) => {
    const items = await this.svc.listDeliveries(
      req.params.teamId,
      req.params.webhookId,
      { limit: req.query.limit },
    );
    return reply.send({ items: items.map(serialiseDelivery) });
  };
}

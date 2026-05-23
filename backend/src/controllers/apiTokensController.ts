import type { FastifyReply, FastifyRequest } from 'fastify';
import { Errors } from '../lib/errors.js';
import type { ApiTokensService } from '../services/apiTokensService.js';
import type { ApiTokenCreateBody } from '../schemas/apiTokens.js';

type IdParams = { tokenId: string };

function serialise(t: {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}) {
  return {
    id: t.id,
    name: t.name,
    prefix: t.prefix,
    scopes: t.scopes,
    createdAt: t.createdAt.toISOString(),
    expiresAt: t.expiresAt?.toISOString() ?? null,
    lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
    revokedAt: t.revokedAt?.toISOString() ?? null,
  };
}

export class ApiTokensController {
  constructor(private readonly svc: ApiTokensService) {}

  list = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) throw Errors.unauthorized();
    const items = await this.svc.list(req.user.sub);
    return reply.send({ items: items.map(serialise) });
  };

  create = async (
    req: FastifyRequest<{ Body: ApiTokenCreateBody }>,
    reply: FastifyReply,
  ) => {
    if (!req.user) throw Errors.unauthorized();
    const { view, rawToken } = await this.svc.generate(req.user.sub, {
      name: req.body.name,
      scopes: req.body.scopes,
      expiresAt: req.body.expiresAt ? new Date(req.body.expiresAt) : null,
    });
    return reply.code(201).send({ ...serialise(view), rawToken });
  };

  revoke = async (req: FastifyRequest<{ Params: IdParams }>, reply: FastifyReply) => {
    if (!req.user) throw Errors.unauthorized();
    await this.svc.revoke(req.user.sub, req.params.tokenId);
    return reply.code(204).send();
  };
}

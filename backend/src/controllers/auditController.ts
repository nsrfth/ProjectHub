import type { FastifyReply, FastifyRequest } from 'fastify';
import { Errors } from '../lib/errors.js';
import type { AuditService } from '../services/auditService.js';
import type { AuditQuery } from '../schemas/audit.js';

export class AuditController {
  constructor(private readonly svc: AuditService) {}

  list = async (req: FastifyRequest<{ Querystring: AuditQuery }>, reply: FastifyReply) => {
    if (!req.user) throw Errors.unauthorized();
    const page = await this.svc.list(
      { sub: req.user.sub, globalRole: req.user.globalRole },
      req.query,
    );
    return reply.send(page);
  };
}

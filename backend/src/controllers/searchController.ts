import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SearchService } from '../services/searchService.js';
import type { SearchQuery } from '../schemas/search.js';
import { Errors } from '../lib/errors.js';

export class SearchController {
  constructor(private readonly svc: SearchService) {}

  list = async (req: FastifyRequest<{ Querystring: SearchQuery }>, reply: FastifyReply) => {
    if (!req.user) throw Errors.unauthorized();
    const results = await this.svc.search(req.user.sub, req.query);
    return reply.send(results);
  };
}

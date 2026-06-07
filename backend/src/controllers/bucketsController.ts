import type { FastifyReply, FastifyRequest } from 'fastify';
import type { BucketView, BucketsService } from '../services/bucketsService.js';
import type {
  CreateBucketBody,
  ReorderBucketsBody,
  UpdateBucketBody,
} from '../schemas/buckets.js';

type ProjectParams = { teamId: string; projectId: string };
type BucketIdParams = { teamId: string; bucketId: string };

function serialize(b: BucketView) {
  return {
    id: b.id,
    projectId: b.projectId,
    name: b.name,
    order: b.order,
    createdAt: b.createdAt.toISOString(),
    updatedAt: b.updatedAt.toISOString(),
  };
}

export class BucketsController {
  constructor(private readonly svc: BucketsService) {}

  list = async (
    req: FastifyRequest<{ Params: ProjectParams }>,
    reply: FastifyReply,
  ) => {
    const items = await this.svc.list(req.params.teamId, req.params.projectId);
    return reply.send(items.map(serialize));
  };

  create = async (
    req: FastifyRequest<{ Params: ProjectParams; Body: CreateBucketBody }>,
    reply: FastifyReply,
  ) => {
    const b = await this.svc.create(req.params.teamId, req.params.projectId, req.body);
    return reply.status(201).send(serialize(b));
  };

  reorder = async (
    req: FastifyRequest<{ Params: ProjectParams; Body: ReorderBucketsBody }>,
    reply: FastifyReply,
  ) => {
    const items = await this.svc.reorder(req.params.teamId, req.params.projectId, req.body);
    return reply.send({ items: items.map(serialize) });
  };

  update = async (
    req: FastifyRequest<{ Params: BucketIdParams; Body: UpdateBucketBody }>,
    reply: FastifyReply,
  ) => {
    const b = await this.svc.update(req.params.teamId, req.params.bucketId, req.body);
    return reply.send(serialize(b));
  };

  remove = async (
    req: FastifyRequest<{ Params: BucketIdParams }>,
    reply: FastifyReply,
  ) => {
    await this.svc.remove(req.params.teamId, req.params.bucketId);
    return reply.status(204).send();
  };
}

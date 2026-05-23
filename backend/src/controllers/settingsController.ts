import type { FastifyReply, FastifyRequest } from 'fastify';
import { Errors } from '../lib/errors.js';
import type { InstanceSettingsService } from '../services/instanceSettingsService.js';
import type {
  InstanceSettingKeyParams,
  InstanceSettingUpsertBody,
} from '../schemas/settings.js';

// Serialise a service-view to the response shape: Date → ISO string, leave
// `value` as-is (the route's Zod response uses `z.unknown()` so arbitrary JSON
// passes through untouched).
function serialise(s: {
  key: string;
  value: unknown;
  updatedAt: Date;
  updatedBy: string | null;
}) {
  return {
    key: s.key,
    value: s.value,
    updatedAt: s.updatedAt.toISOString(),
    updatedBy: s.updatedBy,
  };
}

export class SettingsController {
  constructor(private readonly svc: InstanceSettingsService) {}

  listInstance = async (_req: FastifyRequest, reply: FastifyReply) => {
    const items = await this.svc.list();
    return reply.send({ items: items.map(serialise) });
  };

  getInstance = async (
    req: FastifyRequest<{ Params: InstanceSettingKeyParams }>,
    reply: FastifyReply,
  ) => {
    const row = await this.svc.get(req.params.key);
    if (!row) throw Errors.notFound('Setting not found');
    return reply.send(serialise(row));
  };

  upsertInstance = async (
    req: FastifyRequest<{
      Params: InstanceSettingKeyParams;
      Body: InstanceSettingUpsertBody;
    }>,
    reply: FastifyReply,
  ) => {
    const actorId = req.user!.sub;
    const row = await this.svc.set(req.params.key, req.body.value, actorId);
    return reply.send(serialise(row));
  };

  deleteInstance = async (
    req: FastifyRequest<{ Params: InstanceSettingKeyParams }>,
    reply: FastifyReply,
  ) => {
    const existed = await this.svc.delete(req.params.key);
    if (!existed) throw Errors.notFound('Setting not found');
    return reply.code(204).send();
  };
}

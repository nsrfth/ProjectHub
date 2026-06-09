import type { FastifyReply, FastifyRequest } from 'fastify';
import { Errors } from '../lib/errors.js';
import type { PasswordPolicyBody } from '../schemas/passwordPolicy.js';
import { passwordPolicyService } from '../services/passwordPolicyService.js';

export class SecuritySettingsController {
  getPasswordPolicy = async (_req: FastifyRequest, reply: FastifyReply) => {
    const policy = await passwordPolicyService.getPolicy();
    return reply.send(policy);
  };

  updatePasswordPolicy = async (
    req: FastifyRequest<{ Body: PasswordPolicyBody }>,
    reply: FastifyReply,
  ) => {
    if (!req.user) throw Errors.unauthorized();
    const policy = await passwordPolicyService.updatePolicy(req.user.sub, req.body);
    return reply.send(policy);
  };
}

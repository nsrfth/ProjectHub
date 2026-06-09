import type { FastifyReply, FastifyRequest } from 'fastify';
import { Errors } from '../lib/errors.js';
import type { TaskhubServerUpdateBody } from '../schemas/taskhubServer.js';
import type { PemUploadBody } from '../schemas/taskhubServer.js';
import { taskhubServerService } from '../services/taskhubServerService.js';

export class TaskhubController {
  getServer = async (_req: FastifyRequest, reply: FastifyReply) => {
    const config = await taskhubServerService.getServerConfig();
    const activePort = Number(process.env.CADDY_PUBLIC_PORT ?? process.env.SITE_PORT ?? 80);
    return reply.send({
      ...config,
      activePort: Number.isFinite(activePort) ? activePort : 80,
    });
  };

  updateServer = async (
    req: FastifyRequest<{ Body: TaskhubServerUpdateBody }>,
    reply: FastifyReply,
  ) => {
    if (!req.user) throw Errors.unauthorized();
    const { config, restartRequired } = await taskhubServerService.updateServerConfig(
      req.user.sub,
      req.body,
    );
    const activePort = Number(process.env.CADDY_PUBLIC_PORT ?? 80);
    return reply.send({
      ...config,
      activePort: Number.isFinite(activePort) ? activePort : 80,
      restartRequired,
    });
  };

  getSsl = async (_req: FastifyRequest, reply: FastifyReply) => {
    const info = await taskhubServerService.getSslInfo();
    return reply.send({
      ...info,
      restartRequired: info.hasCertificate && info.hasPrivateKey,
    });
  };

  uploadCertificate = async (
    req: FastifyRequest<{ Body: PemUploadBody }>,
    reply: FastifyReply,
  ) => {
    if (!req.user) throw Errors.unauthorized();
    const info = await taskhubServerService.uploadCertificate(req.user.sub, req.body.pem);
    return reply.send({ ...info, restartRequired: true });
  };

  uploadPrivateKey = async (
    req: FastifyRequest<{ Body: PemUploadBody }>,
    reply: FastifyReply,
  ) => {
    if (!req.user) throw Errors.unauthorized();
    const { info, restartRequired } = await taskhubServerService.uploadPrivateKey(
      req.user.sub,
      req.body.pem,
    );
    return reply.send({ ...info, restartRequired });
  };

  uploadChain = async (
    req: FastifyRequest<{ Body: PemUploadBody }>,
    reply: FastifyReply,
  ) => {
    if (!req.user) throw Errors.unauthorized();
    const info = await taskhubServerService.uploadChain(req.user.sub, req.body.pem);
    return reply.send({ ...info, restartRequired: true });
  };
}

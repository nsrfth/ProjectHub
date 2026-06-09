import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DirectoryService } from '../services/directoryService.js';
import type { LdapService } from '../services/ldapService.js';
import type { ScimCredentialsService } from '../services/scimCredentialsService.js';
import type {
  DirectoryCreateBody,
  DirectoryUpdateBody,
  DirectoryTestBody,
  GroupMappingCreateBody,
} from '../schemas/directories.js';

type IdParams = { directoryId: string };
type MappingParams = { directoryId: string; mappingId: string };

function serialise(d: {
  id: string;
  name: string;
  slug: string;
  kind: 'LDAP' | 'SCIM';
  host: string | null;
  port: number | null;
  useTLS: boolean;
  tlsInsecure: boolean;
  bindDN: string | null;
  hasBindPassword: boolean;
  baseDN: string | null;
  userFilter: string | null;
  groupFilter: string | null;
  userIdAttr: string;
  emailAttr: string;
  nameAttr: string;
  groupMemberAttr: string;
  allowJIT: boolean;
  syncRolesFromGroups: boolean;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    ...d,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

export class DirectoriesController {
  constructor(
    private readonly svc: DirectoryService,
    private readonly ldap: LdapService,
    private readonly scimCreds: ScimCredentialsService,
  ) {}

  list = async (_req: FastifyRequest, reply: FastifyReply) => {
    const items = await this.svc.list();
    return reply.send({ items: items.map(serialise) });
  };

  get = async (req: FastifyRequest<{ Params: IdParams }>, reply: FastifyReply) => {
    const d = await this.svc.get(req.params.directoryId);
    return reply.send(serialise(d));
  };

  create = async (
    req: FastifyRequest<{ Body: DirectoryCreateBody }>,
    reply: FastifyReply,
  ) => {
    const d = await this.svc.create(req.body);
    return reply.code(201).send(serialise(d));
  };

  update = async (
    req: FastifyRequest<{ Params: IdParams; Body: DirectoryUpdateBody }>,
    reply: FastifyReply,
  ) => {
    const d = await this.svc.update(req.params.directoryId, req.body);
    return reply.send(serialise(d));
  };

  remove = async (req: FastifyRequest<{ Params: IdParams }>, reply: FastifyReply) => {
    await this.svc.delete(req.params.directoryId);
    return reply.code(204).send();
  };

  testConnection = async (
    req: FastifyRequest<{ Params: IdParams; Body: DirectoryTestBody }>,
    reply: FastifyReply,
  ) => {
    const raw = await this.svc.getRaw(req.params.directoryId);
    const res = await this.ldap.testConnection(raw, req.body.bindPassword);
    if (res.ok) {
      return reply.send({
        ok: true,
        message: `Bound and found ${res.sampleUserCount} sample user(s).`,
        sampleUserCount: res.sampleUserCount,
      });
    }
    return reply.send({ ok: false, message: res.message });
  };

  // Group mappings -------------------------------------------------------

  listMappings = async (
    req: FastifyRequest<{ Params: IdParams }>,
    reply: FastifyReply,
  ) => {
    const items = await this.svc.listMappings(req.params.directoryId);
    return reply.send({ items });
  };

  createMapping = async (
    req: FastifyRequest<{ Params: IdParams; Body: GroupMappingCreateBody }>,
    reply: FastifyReply,
  ) => {
    const m = await this.svc.createMapping(req.params.directoryId, req.body);
    return reply.code(201).send(m);
  };

  deleteMapping = async (
    req: FastifyRequest<{ Params: MappingParams }>,
    reply: FastifyReply,
  ) => {
    await this.svc.deleteMapping(req.params.directoryId, req.params.mappingId);
    return reply.code(204).send();
  };

  // SCIM credential -----------------------------------------------------
  // GET — returns the current credential (without the raw token) or 204.
  // The raw token is only ever surfaced by `generate`.
  getScimCredential = async (
    req: FastifyRequest<{ Params: IdParams }>,
    reply: FastifyReply,
  ) => {
    const view = await this.scimCreds.get(req.params.directoryId);
    if (!view) return reply.code(204).send();
    return reply.send({
      id: view.id,
      directoryId: view.directoryId,
      name: view.name,
      createdAt: view.createdAt.toISOString(),
      lastUsedAt: view.lastUsedAt?.toISOString() ?? null,
      revokedAt: view.revokedAt?.toISOString() ?? null,
    });
  };

  // POST — create or rotate. Returns the raw token ONCE; subsequent reads
  // will never include it again.
  generateScimCredential = async (
    req: FastifyRequest<{ Params: IdParams; Body: { name: string } }>,
    reply: FastifyReply,
  ) => {
    const { view, rawToken } = await this.scimCreds.generate(req.params.directoryId, req.body.name);
    return reply.code(201).send({
      id: view.id,
      directoryId: view.directoryId,
      name: view.name,
      createdAt: view.createdAt.toISOString(),
      lastUsedAt: null,
      revokedAt: null,
      // Surface the raw token in a field that's CLEARLY one-shot. The
      // frontend stores this nowhere; the admin gets one chance to copy it.
      rawToken,
    });
  };

  revokeScimCredential = async (
    req: FastifyRequest<{ Params: IdParams }>,
    reply: FastifyReply,
  ) => {
    await this.scimCreds.revoke(req.params.directoryId);
    return reply.code(204).send();
  };
}

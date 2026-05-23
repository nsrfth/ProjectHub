import type { FastifyReply, FastifyRequest } from 'fastify';
import { ScimService } from '../services/scimService.js';
import {
  SCIM_LIST_SCHEMA,
  SCIM_GROUP_SCHEMA,
  SCIM_USER_SCHEMA,
  scimError,
} from '../lib/scim.js';

type ScimRequest = FastifyRequest & { scimDirectoryId?: string };
type IdParams = { id: string };

// `?filter=...&startIndex=...&count=...` plus SCIM-specific attr-mask params
// we accept but ignore.
type ListQuery = {
  filter?: string;
  startIndex?: unknown;
  count?: unknown;
  attributes?: string;
  excludedAttributes?: string;
};

function svc(req: FastifyRequest): ScimService {
  // The SCIM "Location" baseUrl points back to the SCIM root so IdPs can
  // follow `meta.location` later. `req.protocol` + `req.hostname` honour
  // the X-Forwarded headers because Fastify is built with `trustProxy: true`.
  const base = `${req.protocol}://${req.hostname}/api/scim/v2`;
  return new ScimService(base);
}

function directoryId(req: FastifyRequest): string {
  const id = (req as ScimRequest).scimDirectoryId;
  if (!id) throw new Error('requireScimAuth was not applied');
  return id;
}

// SCIM responses have a content-type that some IdPs check for:
// application/scim+json. Fall back to application/json if the client
// can't handle it, but always emit the SCIM shape.
function sendScim(reply: FastifyReply, status: number, body: unknown): FastifyReply {
  return reply
    .code(status)
    .header('content-type', 'application/scim+json; charset=utf-8')
    .send(body);
}

export class ScimController {
  // ── ServiceProviderConfig / Schemas / ResourceTypes (public, no auth) ─
  serviceProviderConfig = async (_req: FastifyRequest, reply: FastifyReply) => {
    return sendScim(reply, 200, {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [
        {
          type: 'oauthbearertoken',
          name: 'OAuth Bearer Token',
          description: 'Authentication via OAuth 2.0 Bearer Token',
        },
      ],
    });
  };

  resourceTypes = async (_req: FastifyRequest, reply: FastifyReply) => {
    return sendScim(reply, 200, {
      schemas: [SCIM_LIST_SCHEMA],
      totalResults: 2,
      Resources: [
        {
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
          id: 'User',
          name: 'User',
          endpoint: '/Users',
          schema: SCIM_USER_SCHEMA,
        },
        {
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
          id: 'Group',
          name: 'Group',
          endpoint: '/Groups',
          schema: SCIM_GROUP_SCHEMA,
        },
      ],
    });
  };

  schemas = async (_req: FastifyRequest, reply: FastifyReply) => {
    // Minimal stub — enough for IdPs that GET /Schemas at setup time.
    return sendScim(reply, 200, {
      schemas: [SCIM_LIST_SCHEMA],
      totalResults: 2,
      Resources: [
        { id: SCIM_USER_SCHEMA, name: 'User', description: 'TaskHub user' },
        { id: SCIM_GROUP_SCHEMA, name: 'Group', description: 'TaskHub team' },
      ],
    });
  };

  // ── Users ────────────────────────────────────────────────────────────
  listUsers = async (req: FastifyRequest<{ Querystring: ListQuery }>, reply: FastifyReply) => {
    const list = await svc(req).listUsers(directoryId(req), req.query);
    return sendScim(reply, 200, list);
  };

  getUser = async (req: FastifyRequest<{ Params: IdParams }>, reply: FastifyReply) => {
    const u = await svc(req).getUser(directoryId(req), req.params.id);
    return sendScim(reply, 200, u);
  };

  createUser = async (req: FastifyRequest, reply: FastifyReply) => {
    const u = await svc(req).createUser(directoryId(req), (req.body ?? {}) as Record<string, unknown>);
    return sendScim(reply, 201, u);
  };

  replaceUser = async (req: FastifyRequest<{ Params: IdParams }>, reply: FastifyReply) => {
    const u = await svc(req).replaceUser(directoryId(req), req.params.id, (req.body ?? {}) as Record<string, unknown>);
    return sendScim(reply, 200, u);
  };

  patchUser = async (req: FastifyRequest<{ Params: IdParams }>, reply: FastifyReply) => {
    const u = await svc(req).patchUser(directoryId(req), req.params.id, (req.body ?? {}) as Record<string, unknown>);
    return sendScim(reply, 200, u);
  };

  deleteUser = async (req: FastifyRequest<{ Params: IdParams }>, reply: FastifyReply) => {
    await svc(req).deleteUser(directoryId(req), req.params.id);
    return reply.code(204).send();
  };

  // ── Groups ───────────────────────────────────────────────────────────
  listGroups = async (req: FastifyRequest<{ Querystring: ListQuery }>, reply: FastifyReply) => {
    const list = await svc(req).listGroups(directoryId(req), req.query);
    return sendScim(reply, 200, list);
  };

  getGroup = async (req: FastifyRequest<{ Params: IdParams }>, reply: FastifyReply) => {
    const g = await svc(req).getGroup(directoryId(req), req.params.id);
    return sendScim(reply, 200, g);
  };

  createGroup = async (req: FastifyRequest, reply: FastifyReply) => {
    const g = await svc(req).createGroup(directoryId(req), (req.body ?? {}) as Record<string, unknown>);
    return sendScim(reply, 201, g);
  };

  replaceGroup = async (req: FastifyRequest<{ Params: IdParams }>, reply: FastifyReply) => {
    const g = await svc(req).replaceGroup(directoryId(req), req.params.id, (req.body ?? {}) as Record<string, unknown>);
    return sendScim(reply, 200, g);
  };

  patchGroup = async (req: FastifyRequest<{ Params: IdParams }>, reply: FastifyReply) => {
    const g = await svc(req).patchGroup(directoryId(req), req.params.id, (req.body ?? {}) as Record<string, unknown>);
    return sendScim(reply, 200, g);
  };

  deleteGroup = async (req: FastifyRequest<{ Params: IdParams }>, reply: FastifyReply) => {
    await svc(req).deleteGroup(directoryId(req), req.params.id);
    return reply.code(204).send();
  };
}

// SCIM-shaped error response. Plugged in via app.setErrorHandler for any
// route under /api/scim. Used here only as an exported helper so tests can
// shape their expectations.
export { scimError };

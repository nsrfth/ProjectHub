import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { DirectoryService } from '../services/directoryService.js';
import { LdapService } from '../services/ldapService.js';
import { ScimCredentialsService } from '../services/scimCredentialsService.js';
import { DirectoriesController } from '../controllers/directoriesController.js';
import { requireAuth, requireGlobalAdmin } from '../middleware/auth.js';
import {
  directoryCreateBody,
  directoryUpdateBody,
  directoryResponse,
  directoryListResponse,
  directoryIdParams,
  directoryTestBody,
  directoryTestResponse,
  groupMappingCreateBody,
  groupMappingResponse,
  groupMappingListResponse,
  groupMappingIdParams,
  scimCredentialGenerateBody,
  scimCredentialRedactedResponse,
  scimCredentialCreatedResponse,
} from '../schemas/directories.js';

// Directory CRUD + group-mapping CRUD. Mounted at /api/settings/directories,
// admin-only. Sub-paths:
//   /                       — list + create directories
//   /:directoryId           — get + update + delete
//   /:directoryId/test      — connection test (no persistence)
//   /:directoryId/mappings  — list + create group mappings
//   /:directoryId/mappings/:mappingId — delete mapping
export async function directoriesRoutes(app: FastifyInstance): Promise<void> {
  const svc = new DirectoryService();
  const ldap = new LdapService();
  const scimCreds = new ScimCredentialsService();
  const ctrl = new DirectoriesController(svc, ldap, scimCreds);
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireGlobalAdmin);

  r.get('/', {
    schema: {
      tags: ['directories'],
      summary: 'List all configured directories',
      response: { 200: directoryListResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.list,
  });

  r.post('/', {
    schema: {
      tags: ['directories'],
      summary: 'Create a new directory',
      body: directoryCreateBody,
      response: { 201: directoryResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.create,
  });

  r.get('/:directoryId', {
    schema: {
      tags: ['directories'],
      summary: 'Get one directory',
      params: directoryIdParams,
      response: { 200: directoryResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.get,
  });

  r.patch('/:directoryId', {
    schema: {
      tags: ['directories'],
      summary: 'Update a directory',
      params: directoryIdParams,
      body: directoryUpdateBody,
      response: { 200: directoryResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.update,
  });

  r.delete('/:directoryId', {
    schema: {
      tags: ['directories'],
      summary: 'Delete a directory',
      params: directoryIdParams,
      response: { 204: z.null() },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.remove,
  });

  r.post('/:directoryId/test', {
    schema: {
      tags: ['directories'],
      summary: 'Test the bind + a small user search against an LDAP directory',
      params: directoryIdParams,
      body: directoryTestBody,
      response: { 200: directoryTestResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.testConnection,
  });

  r.get('/:directoryId/mappings', {
    schema: {
      tags: ['directories'],
      summary: 'List group → role mappings for a directory',
      params: directoryIdParams,
      response: { 200: groupMappingListResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.listMappings,
  });

  r.post('/:directoryId/mappings', {
    schema: {
      tags: ['directories'],
      summary: 'Add a group → role mapping',
      params: directoryIdParams,
      body: groupMappingCreateBody,
      response: { 201: groupMappingResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.createMapping,
  });

  r.delete('/:directoryId/mappings/:mappingId', {
    schema: {
      tags: ['directories'],
      summary: 'Remove a group → role mapping',
      params: groupMappingIdParams,
      response: { 204: z.null() },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.deleteMapping,
  });

  // SCIM credential per directory. 1:1 — POST creates or rotates.
  r.get('/:directoryId/scim', {
    schema: {
      tags: ['directories'],
      summary: 'Read the SCIM credential metadata for a directory',
      params: directoryIdParams,
      response: { 200: scimCredentialRedactedResponse, 204: z.null() },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.getScimCredential,
  });

  r.post('/:directoryId/scim', {
    schema: {
      tags: ['directories'],
      summary: 'Create or rotate the SCIM credential. Returns raw token ONCE.',
      params: directoryIdParams,
      body: scimCredentialGenerateBody,
      response: { 201: scimCredentialCreatedResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.generateScimCredential,
  });

  r.delete('/:directoryId/scim', {
    schema: {
      tags: ['directories'],
      summary: 'Revoke the SCIM credential',
      params: directoryIdParams,
      response: { 204: z.null() },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.revokeScimCredential,
  });
}

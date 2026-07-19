import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { DirectoryService } from '../services/directoryService.js';
import { LdapService } from '../services/ldapService.js';
import { DirectorySyncService } from '../services/directorySyncService.js';
import { ScimCredentialsService } from '../services/scimCredentialsService.js';
import { DirectoriesController } from '../controllers/directoriesController.js';
import { requireAuth, requireGlobalAdmin } from '../middleware/auth.js';
import { requireScope } from '../middleware/requireScope.js';
import { loadEnv } from '../config/env.js';
import {
  directoryCreateBody,
  directoryUpdateBody,
  directoryResponse,
  directoryListResponse,
  directoryIdParams,
  directoryTestBody,
  directoryTestResponse,
  directorySyncBody,
  directorySyncResponse,
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
  const sync = new DirectorySyncService(ldap, app.log);
  const ctrl = new DirectoriesController(svc, ldap, scimCreds, sync, loadEnv());
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireGlobalAdmin);
  // v1.30.3 (S-2): API tokens must carry `admin` scope to manage
  // directories or SCIM credentials.
  r.addHook('preHandler', requireScope('admin'));

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

  // v2.6 (Phase 0a). Body defaults dryRun=true, so the destructive form is
  // always an explicit choice; DIRECTORY_SYNC_DRY_RUN=true overrides it back
  // to observation mode regardless of what the caller asks for.
  r.post('/:directoryId/sync', {
    schema: {
      tags: ['directories'],
      summary: 'Run the directory sync now (dry run by default)',
      params: directoryIdParams,
      body: directorySyncBody,
      response: { 200: directorySyncResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.runSync,
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

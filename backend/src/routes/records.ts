import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { RecordService } from '../services/recordService.js';
import { RecordController } from '../controllers/recordController.js';
import { requireAuth, requireTeamRole, requireTeamRoleOrGrantedProject } from '../middleware/auth.js';
import { requireProjectAccess, requireProjectWriteAccess } from '../middleware/requireProjectAccess.js';
import { requirePermission } from '../middleware/requirePermission.js';
import {
  createRecordBody,
  createRecordCommentBody,
  createRecordTypeBody,
  listRecordsQuery,
  recordCommentResponse,
  recordResponse,
  recordTypeResponse,
  transitionRecordBody,
  updateRecordBody,
  updateRecordTypeBody,
} from '../schemas/records.js';

// Team-level record-type catalog. Prefix: /teams/:teamId/record-types
export async function recordTypesRoutes(app: FastifyInstance): Promise<void> {
  const svc = new RecordService();
  const ctrl = new RecordController(svc);
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireTeamRole('MEMBER', 'MANAGER'));

  r.get('/', {
    schema: {
      tags: ['records'],
      summary: 'List record types visible to this team (built-ins + custom)',
      params: z.object({ teamId: z.string() }),
      response: { 200: z.object({ items: z.array(recordTypeResponse) }) },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.listTypes,
  });

  r.post('/', {
    preHandler: [requirePermission('record.manage')],
    schema: {
      tags: ['records'],
      summary: 'Create a custom record type',
      params: z.object({ teamId: z.string() }),
      body: createRecordTypeBody,
      response: { 201: recordTypeResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.createType,
  });

  r.patch('/:typeId', {
    preHandler: [requirePermission('record.manage')],
    schema: {
      tags: ['records'],
      summary: 'Update a custom record type',
      params: z.object({ teamId: z.string(), typeId: z.string() }),
      body: updateRecordTypeBody,
      response: { 200: recordTypeResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.updateType,
  });

  r.delete('/:typeId', {
    preHandler: [requirePermission('record.manage')],
    schema: {
      tags: ['records'],
      summary: 'Delete a custom record type (only if it has no records)',
      params: z.object({ teamId: z.string(), typeId: z.string() }),
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.deleteType,
  });
}

// Project-scoped records. Prefix: /teams/:teamId/projects/:projectId/records
export async function recordsRoutes(app: FastifyInstance): Promise<void> {
  const svc = new RecordService();
  const ctrl = new RecordController(svc);
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireTeamRoleOrGrantedProject('MEMBER', 'MANAGER'));
  r.addHook('preHandler', requireProjectAccess());

  r.get('/', {
    schema: {
      tags: ['records'],
      summary: 'List records in a project',
      params: z.object({ teamId: z.string(), projectId: z.string() }),
      querystring: listRecordsQuery,
      response: { 200: z.object({ items: z.array(recordResponse) }) },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.listRecords,
  });

  r.get('/:recordId', {
    schema: {
      tags: ['records'],
      summary: 'Get a record',
      params: z.object({ teamId: z.string(), projectId: z.string(), recordId: z.string() }),
      response: { 200: recordResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.getRecord,
  });

  r.post('/', {
    preHandler: [requireProjectWriteAccess()],
    schema: {
      tags: ['records'],
      summary: 'Create a record',
      params: z.object({ teamId: z.string(), projectId: z.string() }),
      body: createRecordBody,
      response: { 201: recordResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.createRecord,
  });

  r.patch('/:recordId', {
    preHandler: [requireProjectWriteAccess()],
    schema: {
      tags: ['records'],
      summary: 'Update a record',
      params: z.object({ teamId: z.string(), projectId: z.string(), recordId: z.string() }),
      body: updateRecordBody,
      response: { 200: recordResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.updateRecord,
  });

  r.post('/:recordId/transition', {
    preHandler: [requireProjectWriteAccess()],
    schema: {
      tags: ['records'],
      summary: 'Transition a record to a new status',
      params: z.object({ teamId: z.string(), projectId: z.string(), recordId: z.string() }),
      body: transitionRecordBody,
      response: { 200: recordResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.transitionRecord,
  });

  r.delete('/:recordId', {
    preHandler: [requireProjectWriteAccess()],
    schema: {
      tags: ['records'],
      summary: 'Delete a record',
      params: z.object({ teamId: z.string(), projectId: z.string(), recordId: z.string() }),
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.deleteRecord,
  });

  r.get('/:recordId/comments', {
    schema: {
      tags: ['records'],
      summary: 'List comments on a record',
      params: z.object({ teamId: z.string(), projectId: z.string(), recordId: z.string() }),
      response: { 200: z.object({ items: z.array(recordCommentResponse) }) },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.listComments,
  });

  r.post('/:recordId/comments', {
    // Writing a comment requires project WRITE, consistent with task comments —
    // otherwise a read-only project user could post record comments.
    preHandler: [requireProjectWriteAccess()],
    schema: {
      tags: ['records'],
      summary: 'Add a comment to a record',
      params: z.object({ teamId: z.string(), projectId: z.string(), recordId: z.string() }),
      body: createRecordCommentBody,
      response: { 201: recordCommentResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.createComment,
  });
}

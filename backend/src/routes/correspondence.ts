import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { CorrespondenceService } from '../services/correspondenceService.js';
import { AttachmentsService } from '../services/attachmentsService.js';
import { CorrespondenceController } from '../controllers/correspondenceController.js';
import { requireAuth, requireTeamRoleOrGrantedProject } from '../middleware/auth.js';
import {
  requireProjectAccess,
  requireProjectWriteAccess,
} from '../middleware/requireProjectAccess.js';
import { requireCorrespondenceEnabled } from '../middleware/requireCorrespondenceEnabled.js';
import { requireScope } from '../middleware/requireScope.js';
import { attachmentResponse } from '../schemas/attachments.js';
import {
  correspondenceListResponse,
  correspondenceResponse,
  createCorrespondenceBody,
  createLinkedTaskBody,
  linkedTasksResponse,
  listCorrespondenceQuery,
  referBody,
  referralResponse,
  setStatusBody,
  updateCorrespondenceBody,
} from '../schemas/correspondence.js';
import type { Env } from '../config/env.js';

// v1.90: correspondence (دبیرخانه) letters register. Mounted under the project
// prefix /teams/:teamId/projects/:projectId/correspondence. Hooks:
//   requireAuth → requireTeamRoleOrGrantedProject → requireProjectAccess →
//   requireCorrespondenceEnabled (404s a disabled project's whole module).
// Mutations add requireProjectWriteAccess; the service re-asserts write. The
// referral-handle route deliberately omits project-write — ownership of the
// referral is the gate (enforced in the service).
export async function correspondenceRoutes(
  app: FastifyInstance,
  opts: { env: Env },
): Promise<void> {
  const svc = new CorrespondenceService();
  const attachments = new AttachmentsService(opts.env.UPLOAD_DIR);
  const ctrl = new CorrespondenceController(svc, attachments);
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireTeamRoleOrGrantedProject('MEMBER', 'MANAGER'));
  // Module enablement gate — applies to EVERY correspondence route.
  r.addHook('preHandler', requireCorrespondenceEnabled());
  // v2.5.33: project READ access is NOT a plugin-level hook. It is added
  // per-route to the read endpoints below. Write endpoints carry the stronger
  // requireProjectWriteAccess(). The referred-user action (mark handled) needs
  // NEITHER — a member referred a letter (ارجاع) may have no project access at
  // all, yet must be able to complete their own referral; the service enforces
  // referral ownership (referral.userId === actor). A plugin-level
  // requireProjectAccess() previously 404'd those users out of /handle.

  const projectParams = z.object({ teamId: z.string(), projectId: z.string() });
  const itemParams = projectParams.extend({ id: z.string() });

  r.get('/', {
    preHandler: [requireProjectAccess(), requireScope('correspondence:read')],
    schema: {
      tags: ['correspondence'],
      summary: 'List letters in this project (newest first, excludes deleted)',
      params: projectParams,
      querystring: listCorrespondenceQuery,
      response: { 200: correspondenceListResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.list,
  });

  r.get('/:id', {
    preHandler: [requireProjectAccess(), requireScope('correspondence:read')],
    schema: {
      tags: ['correspondence'],
      summary: 'Get a single letter',
      params: itemParams,
      response: { 200: correspondenceResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.get,
  });

  r.post('/', {
    preHandler: [requireProjectWriteAccess(), requireScope('correspondence:write')],
    schema: {
      tags: ['correspondence'],
      summary: 'Create a letter (auto-numbered {jy}-NNN per Jalali year)',
      params: projectParams,
      body: createCorrespondenceBody,
      response: { 201: correspondenceResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.create,
  });

  r.patch('/:id', {
    preHandler: [requireProjectWriteAccess(), requireScope('correspondence:write')],
    schema: {
      tags: ['correspondence'],
      summary: 'Update a letter (reference number is permanent)',
      params: itemParams,
      body: updateCorrespondenceBody,
      response: { 200: correspondenceResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.update,
  });

  r.patch('/:id/status', {
    preHandler: [requireProjectWriteAccess(), requireScope('correspondence:write')],
    schema: {
      tags: ['correspondence'],
      summary: 'Set a letter status (DRAFT/SENT/RECEIVED/ARCHIVED)',
      params: itemParams,
      body: setStatusBody,
      response: { 200: correspondenceResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.setStatus,
  });

  r.delete('/:id', {
    preHandler: [requireProjectWriteAccess(), requireScope('correspondence:write')],
    schema: {
      tags: ['correspondence'],
      summary: 'Soft-delete a letter',
      params: itemParams,
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.remove,
  });

  // Refer (ارجاع) a letter to team members for ACTION/INFO.
  r.post('/:id/referrals', {
    preHandler: [requireProjectWriteAccess(), requireScope('correspondence:write')],
    schema: {
      tags: ['correspondence'],
      summary: 'Refer a letter to team members (ارجاع)',
      params: itemParams,
      body: referBody,
      response: { 201: correspondenceResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.refer,
  });

  // Mark a referral handled. NO project-write gate — the service enforces that
  // the caller owns the referral (referral.userId === actor).
  r.post('/:id/referrals/:referralId/handle', {
    preHandler: requireScope('correspondence:write'),
    schema: {
      tags: ['correspondence'],
      summary: 'Mark your own referral handled (referred user only)',
      params: itemParams.extend({ referralId: z.string() }),
      response: { 200: referralResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.markReferralHandled,
  });

  // --- Linked tasks (W2.2) ---------------------------------------------------

  r.get('/:id/tasks', {
    preHandler: [requireProjectAccess(), requireScope('correspondence:read')],
    schema: {
      tags: ['correspondence'],
      summary: 'List tasks linked to a letter',
      params: itemParams,
      response: { 200: linkedTasksResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.listLinkedTasks,
  });

  r.post('/:id/tasks', {
    preHandler: [requireProjectWriteAccess(), requireScope('correspondence:write')],
    schema: {
      tags: ['correspondence'],
      summary: 'Create a task in the letter\'s project and link it to the letter',
      params: itemParams,
      body: createLinkedTaskBody,
      response: { 201: linkedTasksResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.linkTask,
  });

  // --- Attachments (correspondence-scoped) ----------------------------------

  r.post('/:id/attachments', {
    preHandler: [requireProjectWriteAccess(), requireScope('correspondence:write')],
    schema: {
      tags: ['correspondence'],
      summary: 'Attach a file to a letter (multipart/form-data; single file)',
      params: itemParams,
      response: { 201: attachmentResponse },
      consumes: ['multipart/form-data'],
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.uploadAttachment,
  });

  r.get('/:id/attachments', {
    // Match the sibling letter reads: project READ access, not merely team
    // membership. requireTeamRoleOrGrantedProject (plugin-level) returns for any
    // team member, so without this a member lacking access to the project could
    // list — and download — its letters' attachments.
    preHandler: [requireProjectAccess(), requireScope('correspondence:read')],
    schema: {
      tags: ['correspondence'],
      summary: 'List a letter attachments (metadata only)',
      params: itemParams,
      response: { 200: z.array(attachmentResponse) },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.listAttachments,
  });

  // No Zod response schema — the response is a binary stream.
  r.get('/:id/attachments/:attachmentId', {
    preHandler: [requireProjectAccess(), requireScope('correspondence:read')],
    schema: {
      tags: ['correspondence'],
      summary: 'Download a letter attachment (forces download)',
      params: itemParams.extend({ attachmentId: z.string() }),
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.downloadAttachment,
  });

  r.delete('/:id/attachments/:attachmentId', {
    preHandler: [requireProjectWriteAccess(), requireScope('correspondence:write')],
    schema: {
      tags: ['correspondence'],
      summary: 'Delete a letter attachment (uploader OR team MANAGER)',
      params: itemParams.extend({ attachmentId: z.string() }),
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.removeAttachment,
  });
}

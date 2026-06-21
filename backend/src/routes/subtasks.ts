import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { SubtasksService } from '../services/subtasksService.js';
import { SubtasksController } from '../controllers/subtasksController.js';
import { requireAuth, requireTeamRoleOrGrantedProject } from '../middleware/auth.js';
import { requireProjectAccess, requireProjectWriteAccess } from '../middleware/requireProjectAccess.js';
import { requireScope } from '../middleware/requireScope.js';
import {
  createSubtaskBody,
  reorderSubtasksBody,
  reorderSubtasksResponse,
  subtaskResponse,
  updateSubtaskBody,
  updateSubtaskStatusBody,
} from '../schemas/subtasks.js';

// Subtasks live under /api/teams/:teamId/projects/:projectId/tasks/:taskId/subtasks.
// There's no GET list endpoint — the parent task response already carries
// `subtasks: [...]` (see tasksService.TASK_INCLUDE).
export async function subtasksRoutes(app: FastifyInstance): Promise<void> {
  const svc = new SubtasksService();
  const ctrl = new SubtasksController(svc);
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.addHook('preHandler', requireAuth);
  r.addHook('preHandler', requireTeamRoleOrGrantedProject('MEMBER', 'MANAGER'));
  // v1.39: project visibility cascade.
  r.addHook('preHandler', requireProjectAccess());

  r.post('/', {
    preHandler: [requireProjectWriteAccess(), requireScope('tasks:write')],
    schema: {
      tags: ['subtasks'],
      summary: 'Add a subtask (appended to the end)',
      params: z.object({ teamId: z.string(), projectId: z.string(), taskId: z.string() }),
      body: createSubtaskBody,
      response: { 201: subtaskResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.create,
  });

  r.patch('/:subtaskId', {
    // v1.88: not requireProjectWriteAccess — a granular delegate (project READ)
    // may edit the fields their capabilities cover. subtasksService.update
    // enforces write-vs-capability per field; the route-level requireProjectAccess
    // hook still blocks non-members (READ minimum).
    preHandler: requireScope('tasks:write'),
    schema: {
      tags: ['subtasks'],
      summary: 'Update a subtask (write access or a matching delegate capability)',
      params: z.object({
        teamId: z.string(),
        projectId: z.string(),
        taskId: z.string(),
        subtaskId: z.string(),
      }),
      body: updateSubtaskBody,
      response: { 200: subtaskResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.update,
  });

  // v1.82: focused status-only update. NOTE: deliberately NOT
  // requireProjectWriteAccess — the subtask's RESPONSIBLE person or ASSIGNEE
  // may change its status without holding full subtask-edit (project WRITE).
  // Project READ access is still enforced by the requireProjectAccess hook
  // above; the service authorizes the change (responsible || assignee || WRITE)
  // and rejects others with 403.
  r.patch('/:subtaskId/status', {
    preHandler: requireScope('tasks:write'),
    schema: {
      tags: ['subtasks'],
      summary: "Change a subtask's progress status (responsible / assignee / editor)",
      params: z.object({
        teamId: z.string(),
        projectId: z.string(),
        taskId: z.string(),
        subtaskId: z.string(),
      }),
      body: updateSubtaskStatusBody,
      response: { 200: subtaskResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.setStatus,
  });

  // v1.35: full-permutation reorder. Mirrors the bucket reorder route.
  r.patch('/reorder', {
    preHandler: [requireProjectWriteAccess(), requireScope('tasks:write')],
    schema: {
      tags: ['subtasks'],
      summary:
        "Reorder subtasks for a task. Body must be a FULL permutation of every subtaskId on the task (strict mode).",
      params: z.object({ teamId: z.string(), projectId: z.string(), taskId: z.string() }),
      body: reorderSubtasksBody,
      response: { 200: reorderSubtasksResponse },
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.reorder,
  });

  r.delete('/:subtaskId', {
    preHandler: [requireProjectWriteAccess(), requireScope('tasks:write')],
    schema: {
      tags: ['subtasks'],
      summary: 'Delete a subtask',
      params: z.object({
        teamId: z.string(),
        projectId: z.string(),
        taskId: z.string(),
        subtaskId: z.string(),
      }),
      security: [{ bearerAuth: [] }],
    },
    handler: ctrl.remove,
  });
}

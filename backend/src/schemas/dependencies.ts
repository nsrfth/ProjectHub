import { z } from 'zod';
import { taskStatusEnum } from './tasks.js';

// v1.29: shapes for /teams/:teamId/projects/:projectId/tasks/:taskId/dependencies.

export const dependencyTypeEnum = z.enum(['FINISH_TO_START', 'RELATES_TO']);

export const createDependencyBody = z.object({
  // The blocker — i.e. the task the URL task should depend on. Must be in
  // the same team + project; cycle prevention is server-side.
  dependsOnId: z.string().min(1),
  type: dependencyTypeEnum.default('FINISH_TO_START'),
});

// One side of the GET response. `task` is always the OTHER task on the
// edge: the blocker (when listed under blockedBy) or the dependent (when
// listed under blocking).
export const dependencyEdgeResponse = z.object({
  id: z.string(),
  type: dependencyTypeEnum,
  createdAt: z.string(),
  task: z.object({
    id: z.string(),
    title: z.string(),
    status: taskStatusEnum,
    projectId: z.string(),
  }),
});

export const dependencyListResponse = z.object({
  blockedBy: z.array(dependencyEdgeResponse),
  blocking: z.array(dependencyEdgeResponse),
  // Surfaces the instance setting so the UI knows whether to render the
  // warn-pre-flight tooltip and whether to expect 403s on status changes.
  enforcement: z.enum(['off', 'warn', 'block']),
});

export const dependencyParams = z.object({
  teamId: z.string(),
  projectId: z.string(),
  taskId: z.string(),
});

export const dependencyIdParams = dependencyParams.extend({
  dependencyId: z.string(),
});

export type CreateDependencyBody = z.infer<typeof createDependencyBody>;

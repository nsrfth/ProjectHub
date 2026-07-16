import { prisma } from '../data/prisma.js';
import { Errors } from './errors.js';

/**
 * v2.5.58: project plan freeze (Project.datesFrozen).
 *
 * Call sites — every writer of PLAN dates:
 *   tasksService.create/update    (startDate, dueDate, plannedDate, baselineStart/End)
 *   subtasksService.create/update (startDate, endDate)
 *   projectsService.update        (project startDate/endDate)
 *   taskTemplatesService.spawnDue (skips frozen projects instead of throwing)
 *
 * Deliberately NOT gated: completedAt (incl. DONE auto-fill and approval
 * decisions), actualStart/actualEnd, status changes, progress — freezing the
 * plan must never stop the team from recording reality.
 */
export async function assertProjectDatesNotFrozen(projectId: string): Promise<void> {
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: { datesFrozen: true },
  });
  if (p?.datesFrozen) throw Errors.datesFrozen();
}

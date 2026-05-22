import type { FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../data/prisma.js';
import type { TasksService } from '../services/tasksService.js';

type TaskParams = { teamId: string; projectId: string; taskId: string };

export class ActivityController {
  constructor(private readonly tasks: TasksService) {}

  // Read the audit trail for a single task. The activity log is task-scoped;
  // a team-level or user-level feed would be a separate endpoint with its own
  // RBAC + pagination story.
  list = async (req: FastifyRequest<{ Params: TaskParams }>, reply: FastifyReply) => {
    // Parent-chain check — 404 on cross-tenant probing.
    await this.tasks.get(req.params.teamId, req.params.projectId, req.params.taskId);

    const rows = await prisma.activity.findMany({
      where: { taskId: req.params.taskId },
      // Newest first — the typical reader wants "what just happened" at the top.
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { actor: { select: { name: true } } },
    });

    return reply.send(
      rows.map((a) => ({
        id: a.id,
        taskId: a.taskId,
        actorId: a.actorId,
        actorName: a.actor.name,
        action: a.action,
        meta: a.meta,
        createdAt: a.createdAt.toISOString(),
      })),
    );
  };
}

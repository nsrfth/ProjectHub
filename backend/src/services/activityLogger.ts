import type { Prisma } from '@prisma/client';
import { prisma } from '../data/prisma.js';

// Centralized writer for the Activity log so every emit site uses the same
// shape and we can later add fan-out (e.g., create Notifications, push events
// over WebSockets) in one place. Best-effort writes — a failed audit row must
// never block the user-facing mutation that triggered it.
//
// Phase 3A: teamId is denormalized onto the row. When the caller supplies
// taskId but not teamId, we resolve teamId from the task. Future event types
// that aren't task-scoped pass teamId directly (or leave both null for
// instance-wide events).
export async function logActivity(
  client: Prisma.TransactionClient | typeof prisma,
  input: {
    taskId?: string | null;
    teamId?: string | null;
    // Nullable: system-emitted events (scheduler, SCIM auto-provision) have
    // no human actor. Callers passing a real user keep using the string form.
    actorId: string | null;
    action: string;
    meta?: Prisma.InputJsonValue;
  },
): Promise<void> {
  try {
    let teamId = input.teamId ?? null;
    if (!teamId && input.taskId) {
      const task = await client.task.findUnique({
        where: { id: input.taskId },
        select: { teamId: true },
      });
      if (task) teamId = task.teamId;
    }
    await client.activity.create({
      data: {
        taskId: input.taskId ?? null,
        teamId,
        actorId: input.actorId,
        action: input.action,
        meta: input.meta ?? {},
      },
    });
  } catch {
    // Swallow — the activity log is observability, not a hard requirement.
    // If we ever care about audit-grade guarantees, replace this with a hard
    // failure or an outbox table.
  }
}

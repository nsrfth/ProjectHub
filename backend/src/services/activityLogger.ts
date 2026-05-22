import type { Prisma } from '@prisma/client';
import { prisma } from '../data/prisma.js';

// Centralized writer for the Activity log so every emit site uses the same
// shape and we can later add fan-out (e.g., create Notifications, push events
// over WebSockets) in one place. Best-effort writes — a failed audit row must
// never block the user-facing mutation that triggered it.
export async function logActivity(
  client: Prisma.TransactionClient | typeof prisma,
  input: {
    taskId: string;
    actorId: string;
    action: string;
    meta?: Prisma.InputJsonValue;
  },
): Promise<void> {
  try {
    await client.activity.create({
      data: {
        taskId: input.taskId,
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

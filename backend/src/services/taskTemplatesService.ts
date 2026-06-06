import type { Prisma, TaskTemplate } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';
import {
  addDays,
  firstOccurrenceOnOrAfter,
  nextOccurrenceAfter,
  periodKey,
  utcMidnight,
} from '../lib/recurrence.js';

// Manage the TaskTemplate row attached to a source Task. Each task can have
// at most one template (sourceTaskId is UNIQUE in the schema).

export interface TaskTemplateView {
  id: string;
  sourceTaskId: string;
  frequency: TaskTemplate['frequency'];
  interval: number;
  byWeekday: number[];
  startsOn: string;
  endsOn: string | null;
  maxCount: number | null;
  dueOffsetDays: number | null;
  plannedOffsetDays: number | null;
  nextRunAt: string;
  spawnedCount: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TaskTemplateUpsertInput {
  frequency: TaskTemplate['frequency'];
  interval: number;
  byWeekday?: number[];
  startsOn: string; // ISO date — gets snapped to UTC midnight server-side
  endsOn?: string | null;
  maxCount?: number | null;
  dueOffsetDays?: number | null;
  plannedOffsetDays?: number | null;
  active?: boolean;
}

function toView(t: TaskTemplate): TaskTemplateView {
  return {
    id: t.id,
    sourceTaskId: t.sourceTaskId,
    frequency: t.frequency,
    interval: t.interval,
    byWeekday: t.byWeekday,
    startsOn: t.startsOn.toISOString(),
    endsOn: t.endsOn?.toISOString() ?? null,
    maxCount: t.maxCount,
    dueOffsetDays: t.dueOffsetDays,
    plannedOffsetDays: t.plannedOffsetDays,
    nextRunAt: t.nextRunAt.toISOString(),
    spawnedCount: t.spawnedCount,
    active: t.active ?? true,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

export class TaskTemplatesService {
  async get(sourceTaskId: string): Promise<TaskTemplateView | null> {
    const row = await prisma.taskTemplate.findUnique({ where: { sourceTaskId } });
    return row ? toView(row) : null;
  }

  // Upsert. nextRunAt is auto-computed from startsOn + the rule so the
  // caller doesn't have to know the math. On update, if startsOn / rule
  // changes we re-anchor nextRunAt to the next-after-now occurrence so a
  // template that's been silent doesn't replay missed periods.
  async upsert(sourceTaskId: string, input: TaskTemplateUpsertInput): Promise<TaskTemplateView> {
    const task = await prisma.task.findUnique({ where: { id: sourceTaskId } });
    if (!task) throw Errors.notFound('Task not found');

    const startsOn = utcMidnight(new Date(input.startsOn));
    const endsOn = input.endsOn ? utcMidnight(new Date(input.endsOn)) : null;
    const interval = Math.max(1, input.interval);
    const byWeekday = input.byWeekday ?? [];

    // Compute nextRunAt: first occurrence on/after max(startsOn, today).
    const today = utcMidnight(new Date());
    const anchor = startsOn.getTime() > today.getTime() ? startsOn : today;
    let nextRunAt = firstOccurrenceOnOrAfter(
      { frequency: input.frequency, interval, byWeekday },
      anchor,
    );
    // If the anchor itself isn't a match for WEEKLY+byWeekday, the helper
    // already advanced. Defensive: never schedule before today.
    if (nextRunAt.getTime() < today.getTime()) nextRunAt = today;

    const data: Prisma.TaskTemplateUncheckedCreateInput = {
      sourceTaskId,
      frequency: input.frequency,
      interval,
      byWeekday,
      startsOn,
      endsOn,
      maxCount: input.maxCount ?? null,
      dueOffsetDays: input.dueOffsetDays ?? null,
      plannedOffsetDays: input.plannedOffsetDays ?? null,
      nextRunAt,
      active: input.active ?? true,
    };
    const row = await prisma.taskTemplate.upsert({
      where: { sourceTaskId },
      create: data,
      update: {
        frequency: data.frequency,
        interval: data.interval,
        byWeekday: data.byWeekday,
        startsOn: data.startsOn,
        endsOn: data.endsOn,
        maxCount: data.maxCount,
        dueOffsetDays: data.dueOffsetDays,
        plannedOffsetDays: data.plannedOffsetDays,
        nextRunAt: data.nextRunAt,
        active: data.active,
      },
    });
    return toView(row);
  }

  async delete(sourceTaskId: string): Promise<void> {
    const row = await prisma.taskTemplate.findUnique({ where: { sourceTaskId } });
    if (!row) return;
    await prisma.taskTemplate.delete({ where: { sourceTaskId } });
  }

  // ── Spawn ────────────────────────────────────────────────────────────
  // Process every active template whose nextRunAt has elapsed. Idempotent:
  // each spawn carries a (templateId, period) unique key, so a retried tick
  // can't insert a duplicate. Returns the number of tasks spawned.
  async spawnDue(now = new Date()): Promise<number> {
    // We don't filter endsOn at the query level — endsOn applies to the
    // spawn PERIOD (nextRunAt), not to `now`. A template with
    // nextRunAt=Mon and endsOn=Mon, processed Tue, still owes us Monday's
    // spawn. The per-template loop below applies the cutoff.
    const ready = await prisma.taskTemplate.findMany({
      where: {
        active: true,
        nextRunAt: { lte: now },
      },
      include: {
        sourceTask: {
          include: {
            labels: true,
            subtasks: { orderBy: { position: 'asc' } },
          },
        },
      },
    });

    let spawned = 0;
    for (const t of ready) {
      // maxCount cap.
      if (t.maxCount !== null && t.spawnedCount >= t.maxCount) {
        // Deactivate so we don't pick this up again.
        await prisma.taskTemplate.update({ where: { id: t.id }, data: { active: false } });
        continue;
      }
      // endsOn applies to the spawn period itself: if the period
      // (nextRunAt) lies after endsOn, the rule has lapsed.
      if (t.endsOn && t.nextRunAt.getTime() > t.endsOn.getTime()) {
        await prisma.taskTemplate.update({ where: { id: t.id }, data: { active: false } });
        continue;
      }

      const spawnDate = utcMidnight(t.nextRunAt);
      const key = periodKey(spawnDate);
      const next = nextOccurrenceAfter(
        { frequency: t.frequency, interval: t.interval, byWeekday: t.byWeekday },
        spawnDate,
      );

      // Transaction: insert the Task (catching the unique-violation duplicate
      // path) + advance the template. If the task already existed for this
      // period, just advance the template forward so we don't loop forever.
      try {
        await prisma.$transaction(async (tx) => {
          const src = t.sourceTask;
          const dueDate = t.dueOffsetDays !== null ? addDays(spawnDate, t.dueOffsetDays) : null;
          const plannedDate = t.plannedOffsetDays !== null ? addDays(spawnDate, t.plannedOffsetDays) : null;
          await tx.task.create({
            data: {
              projectId: src.projectId,
              teamId: src.teamId,
              creatorId: src.creatorId,
              assigneeId: src.assigneeId,
              title: src.title,
              description: src.description,
              status: 'TODO',
              priority: src.priority,
              dueDate,
              plannedDate,
              spawnedFromTemplateId: t.id,
              spawnedForPeriod: key,
              labels: {
                create: src.labels.map((l) => ({ labelId: l.labelId })),
              },
              subtasks: {
                create: src.subtasks.map((s) => ({
                  title: s.title,
                  done: false,
                  position: s.position,
                })),
              },
            },
          });
          await tx.taskTemplate.update({
            where: { id: t.id },
            data: { nextRunAt: next, spawnedCount: { increment: 1 } },
          });
        });
        spawned += 1;
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === 'P2002') {
          // Already spawned for this period (concurrent tick). Just advance.
          await prisma.taskTemplate.update({
            where: { id: t.id },
            data: { nextRunAt: next },
          });
          continue;
        }
        throw e;
      }
    }
    return spawned;
  }
}

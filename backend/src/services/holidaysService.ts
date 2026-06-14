import { Prisma } from '@prisma/client';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';
import { resolveDatasetHolidays } from '../lib/irHolidayDataset.js';
import type { IrHolidayType } from '../lib/irHolidayDataset.js';
import { logActivity } from './activityLogger.js';
import type { CreateHolidayBody, UpdateHolidayBody } from '../schemas/holidays.js';

export interface HolidayView {
  id: string;
  date: string;
  name: string;
  recurring: boolean;
  source: 'MANUAL' | 'IMPORT' | 'SYNC';
  createdAt: string;
  updatedAt: string;
}

/** Calendar dates only — anchor to UTC midnight (matches task dueDate rule). */
export function normalizeUtcMidnight(input: string | Date): Date {
  const d = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) throw Errors.badRequest('Invalid date');
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function toView(row: {
  id: string;
  date: Date;
  name: string;
  recurring: boolean;
  source: 'MANUAL' | 'IMPORT' | 'SYNC';
  createdAt: Date;
  updatedAt: Date;
}): HolidayView {
  return {
    id: row.id,
    date: row.date.toISOString(),
    name: row.name,
    recurring: row.recurring,
    source: row.source,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface ImportPreviewEntry {
  date: string;
  name: string;
  type: IrHolidayType;
  recurring: boolean;
}

export interface ImportConflictEntry {
  date: string;
  datasetName: string;
  existingName: string;
  existingSource: 'MANUAL' | 'IMPORT' | 'SYNC';
}

export interface ImportSkippedEntry {
  date: string;
  name: string;
  existingName: string;
  reason: 'already_imported';
}

export interface ImportPreviewResult {
  jalaliYear: number;
  added: ImportPreviewEntry[];
  skipped: ImportSkippedEntry[];
  conflicts: ImportConflictEntry[];
}

export interface ImportResult extends ImportPreviewResult {
  inserted: number;
}

export class HolidaysService {
  async list(opts?: { year?: number; from?: string; to?: string }): Promise<HolidayView[]> {
    const where: Prisma.HolidayWhereInput = {};
    if (opts?.year !== undefined) {
      where.date = {
        gte: new Date(Date.UTC(opts.year, 0, 1)),
        lte: new Date(Date.UTC(opts.year, 11, 31, 23, 59, 59, 999)),
      };
    } else if (opts?.from || opts?.to) {
      where.date = {};
      if (opts.from) where.date.gte = normalizeUtcMidnight(opts.from);
      if (opts.to) where.date.lte = normalizeUtcMidnight(opts.to);
    }
    const rows = await prisma.holiday.findMany({ where, orderBy: { date: 'asc' } });
    return rows.map(toView);
  }

  async listForBootstrap(): Promise<HolidayView[]> {
    const now = new Date();
    const from = new Date(Date.UTC(now.getUTCFullYear() - 1, 0, 1));
    const to = new Date(Date.UTC(now.getUTCFullYear() + 2, 11, 31));
    const rows = await prisma.holiday.findMany({
      where: { date: { gte: from, lte: to } },
      orderBy: { date: 'asc' },
    });
    return rows.map(toView);
  }

  async create(actorId: string, input: CreateHolidayBody): Promise<HolidayView> {
    const date = normalizeUtcMidnight(input.date);
    try {
      const row = await prisma.holiday.create({
        data: {
          date,
          name: input.name,
          recurring: input.recurring ?? false,
          source: input.source ?? 'MANUAL',
          createdById: actorId,
        },
      });
      await logActivity(prisma, {
        actorId,
        action: 'holiday.created',
        meta: { holidayId: row.id, name: row.name, date: row.date.toISOString() },
      });
      return toView(row);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw Errors.conflict('A holiday already exists on that date');
      }
      throw err;
    }
  }

  async update(holidayId: string, actorId: string, input: UpdateHolidayBody): Promise<HolidayView> {
    const existing = await prisma.holiday.findUnique({ where: { id: holidayId } });
    if (!existing) throw Errors.notFound('Holiday not found');
    const data: Prisma.HolidayUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.recurring !== undefined) data.recurring = input.recurring;
    if (input.date !== undefined) data.date = normalizeUtcMidnight(input.date);
    try {
      const row = await prisma.holiday.update({ where: { id: holidayId }, data });
      await logActivity(prisma, {
        actorId,
        action: 'holiday.updated',
        meta: { holidayId: row.id, name: row.name, date: row.date.toISOString() },
      });
      return toView(row);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw Errors.conflict('A holiday already exists on that date');
      }
      throw err;
    }
  }

  async remove(holidayId: string, actorId: string): Promise<void> {
    const existing = await prisma.holiday.findUnique({ where: { id: holidayId } });
    if (!existing) throw Errors.notFound('Holiday not found');
    await prisma.holiday.delete({ where: { id: holidayId } });
    await logActivity(prisma, {
      actorId,
      action: 'holiday.deleted',
      meta: { holidayId, name: existing.name, date: existing.date.toISOString() },
    });
  }

  async previewImportFromDataset(jalaliYear: number): Promise<ImportPreviewResult> {
    return this.diffImport(jalaliYear);
  }

  async importFromDataset(actorId: string, jalaliYear: number): Promise<ImportResult> {
    const diff = await this.diffImport(jalaliYear);
    let inserted = 0;
    for (const row of diff.added) {
      await prisma.holiday.create({
        data: {
          date: new Date(row.date),
          name: row.name,
          recurring: row.recurring,
          source: 'IMPORT',
          createdById: actorId,
        },
      });
      inserted += 1;
    }
    if (inserted > 0 || diff.conflicts.length > 0 || diff.skipped.length > 0) {
      await logActivity(prisma, {
        actorId,
        action: 'holiday.imported',
        meta: {
          jalaliYear,
          inserted,
          skipped: diff.skipped.length,
          conflicts: diff.conflicts.length,
        },
      });
    }
    return { ...diff, inserted };
  }

  private async diffImport(jalaliYear: number): Promise<ImportPreviewResult> {
    const resolved = resolveDatasetHolidays(jalaliYear);
    if (resolved.length === 0) {
      throw Errors.badRequest(`No dataset entries for Jalali year ${jalaliYear}`);
    }
    const dates = resolved.map((r) => r.date);
    const existing = await prisma.holiday.findMany({
      where: { date: { in: dates } },
    });
    const byDate = new Map(existing.map((h) => [h.date.toISOString(), h]));

    const added: ImportPreviewEntry[] = [];
    const skipped: ImportSkippedEntry[] = [];
    const conflicts: ImportConflictEntry[] = [];

    for (const row of resolved) {
      const hit = byDate.get(row.dateIso);
      if (!hit) {
        added.push({
          date: row.dateIso,
          name: row.name,
          type: row.type as IrHolidayType,
          recurring: row.recurring,
        });
        continue;
      }
      if (hit.source === 'IMPORT') {
        skipped.push({
          date: row.dateIso,
          name: row.name,
          existingName: hit.name,
          reason: 'already_imported',
        });
        continue;
      }
      conflicts.push({
        date: row.dateIso,
        datasetName: row.name,
        existingName: hit.name,
        existingSource: hit.source,
      });
    }

    return { jalaliYear, added, skipped, conflicts };
  }
}

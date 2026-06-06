import { prisma } from '../data/prisma.js';

// CRUD over the InstanceSetting key-value table. Per-key value shapes are not
// enforced here — the consumer of each setting validates its own shape on
// read. This keeps adding a new toggle a zero-migration change.

export interface InstanceSettingView {
  key: string;
  value: unknown;
  updatedAt: Date;
  updatedBy: string | null;
}

export class InstanceSettingsService {
  async list(): Promise<InstanceSettingView[]> {
    const rows = await prisma.instanceSetting.findMany({
      orderBy: { key: 'asc' },
    });
    return rows.map((r) => ({
      key: r.key,
      value: r.value as unknown,
      updatedAt: r.updatedAt,
      updatedBy: r.updatedBy,
    }));
  }

  async get(key: string): Promise<InstanceSettingView | null> {
    const row = await prisma.instanceSetting.findUnique({ where: { key } });
    if (!row) return null;
    return {
      key: row.key,
      value: row.value as unknown,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
    };
  }

  async set(
    key: string,
    value: unknown,
    actorId: string,
  ): Promise<InstanceSettingView> {
    const row = await prisma.instanceSetting.upsert({
      where: { key },
      // Prisma's Json column accepts arbitrary JSON-serialisable values. Cast
      // to the runtime any to satisfy the JsonValue typing without rewriting
      // the caller's `unknown` boundary.
      update: { value: value as never, updatedBy: actorId },
      create: { key, value: value as never, updatedBy: actorId },
    });
    return {
      key: row.key,
      value: row.value as unknown,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
    };
  }

  async delete(key: string): Promise<boolean> {
    const res = await prisma.instanceSetting.deleteMany({ where: { key } });
    return res.count > 0;
  }
}

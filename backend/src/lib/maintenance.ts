import { prisma } from '../data/prisma.js';

// v1.30.4 (S-5): server-wide maintenance flag.
//
// Stored as an InstanceSetting (key: 'system.maintenanceMode'). When set
// to a truthy object, an early Fastify onRequest hook returns 503 for
// every route except the health probe. Used by the backup-restore flow
// to drain the listener while pg_restore is in flight.
//
// The maintenance setting is INTENTIONALLY persisted in the DB rather
// than held in process memory: the restore flow terminates the backend
// process so compose can restart it cleanly. On the fresh boot the new
// process reads the flag, knows it's mid-recovery, then clears it once
// the listener comes up successfully.

export const MAINTENANCE_KEY = 'system.maintenanceMode';

export interface MaintenanceState {
  enabled: boolean;
  // ISO-8601 stamp the maintenance window started. Surfaced in the 503
  // response so admins can see how long it's been blocked.
  since: string | null;
  // Human-readable reason — e.g. "restoring backup taskhub-…dump". Also
  // surfaced in the 503 so logs aren't a mystery.
  reason: string | null;
}

export const MAINTENANCE_OFF: MaintenanceState = {
  enabled: false,
  since: null,
  reason: null,
};

// True when the persisted state has `enabled: true`. Defensive against
// older schemaless rows (treat anything truthy as enabled, but parse
// out the `since`/`reason` if present).
export async function readMaintenance(): Promise<MaintenanceState> {
  try {
    const row = await prisma.instanceSetting.findUnique({
      where: { key: MAINTENANCE_KEY },
    });
    if (!row) return MAINTENANCE_OFF;
    const v = row.value as { enabled?: unknown; since?: unknown; reason?: unknown } | null;
    if (!v || typeof v !== 'object' || v.enabled !== true) return MAINTENANCE_OFF;
    return {
      enabled: true,
      since: typeof v.since === 'string' ? v.since : null,
      reason: typeof v.reason === 'string' ? v.reason : null,
    };
  } catch {
    // DB unreachable → safer to ASSUME maintenance off so admins can
    // log in to fix things. The restore path explicitly closes the
    // pool before invoking pg_restore so this branch fires legitimately
    // mid-restore — the listener is already shutting down by then.
    return MAINTENANCE_OFF;
  }
}

export async function setMaintenance(reason: string, actorId: string | null): Promise<void> {
  const value = {
    enabled: true,
    since: new Date().toISOString(),
    reason,
  };
  await prisma.instanceSetting.upsert({
    where: { key: MAINTENANCE_KEY },
    update: { value: value as never, updatedBy: actorId },
    create: { key: MAINTENANCE_KEY, value: value as never, updatedBy: actorId },
  });
}

// Delete the row outright rather than setting `enabled: false` so the
// catch-all reader treats "no setting" and "off" identically. Called by
// server.ts on fresh boot.
export async function clearMaintenance(): Promise<void> {
  await prisma.instanceSetting
    .deleteMany({ where: { key: MAINTENANCE_KEY } })
    .catch(() => undefined);
}

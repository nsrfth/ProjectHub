import type { onRequestHookHandler } from 'fastify';
import { readMaintenance } from '../lib/maintenance.js';

// v1.30.4 (S-5): early global gate that returns 503 for every route
// EXCEPT the health probe(s) while the `system.maintenanceMode`
// InstanceSetting is set.
//
// Lifecycle position: `onRequest` runs before content-type parsing,
// validation, and any per-route preHandler — the earliest hook
// Fastify offers. Cheap reads only (one DB roundtrip on the
// InstanceSetting row, which is small + indexed by key). When the flag
// is on we DON'T fan out the DB hit per request — we cache the
// in-memory snapshot for 1s so a flood of requests during a restore
// doesn't hammer the DB pool while it's about to be torn down.

const CACHE_TTL_MS = 1_000;

// Exempt paths. /health is the existing internal probe (Caddy doesn't
// route to it from the public hostname; docker healthcheck uses it).
// /api/health is the public surface, kept exempt so an operator can
// curl it during a restore to know when the new backend is up.
const EXEMPT = new Set(['/health', '/api/health']);

interface CachedSnapshot {
  enabled: boolean;
  since: string | null;
  reason: string | null;
  fetchedAt: number;
}
let cached: CachedSnapshot | null = null;

// Test-only escape hatch — vitest resets process state between files
// but the cache lives at module scope.
export function _resetMaintenanceCache(): void {
  cached = null;
}

export const maintenanceGate: onRequestHookHandler = async (request, reply) => {
  const url = request.url.split('?')[0] ?? '';
  if (EXEMPT.has(url)) return;

  const now = Date.now();
  if (!cached || now - cached.fetchedAt > CACHE_TTL_MS) {
    const state = await readMaintenance();
    cached = {
      enabled: state.enabled,
      since: state.since,
      reason: state.reason,
      fetchedAt: now,
    };
  }
  if (!cached.enabled) return;

  // Return a structured 503 so the SPA can render a friendly banner.
  // Retry-After is advisory; we don't know exactly how long the restore
  // will take, but 30s is the right order of magnitude — the admin who
  // triggered it will refresh sooner anyway.
  reply
    .header('Retry-After', '30')
    .code(503)
    .send({
      error: {
        code: 'MAINTENANCE',
        message:
          (cached.reason ?? 'Server is temporarily unavailable for maintenance.') +
          (cached.since ? ` (since ${cached.since})` : ''),
      },
    });
};

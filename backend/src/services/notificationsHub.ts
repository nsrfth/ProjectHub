import type { WebSocket } from '@fastify/websocket';

// In-process pub/sub for the WebSocket notification feed. Keyed by userId so
// each user only sees their own events. Multi-instance deployments would need
// to replace this with a Redis pub/sub (the existing Redis container is the
// natural home); for the single-replica Compose setup, in-memory is enough.
const sockets = new Map<string, Set<WebSocket>>();

export const notificationsHub = {
  subscribe(userId: string, ws: WebSocket): () => void {
    let set = sockets.get(userId);
    if (!set) {
      set = new Set();
      sockets.set(userId, set);
    }
    set.add(ws);
    return () => {
      const s = sockets.get(userId);
      if (!s) return;
      s.delete(ws);
      if (s.size === 0) sockets.delete(userId);
    };
  },

  // Send a "something new arrived" ping to all of a user's open sockets. The
  // payload is intentionally minimal — clients re-fetch via the normal REST
  // endpoint, which keeps the WS protocol stable as the notification shape
  // evolves and lets the cache layer (TanStack Query) handle dedup.
  publish(userId: string, event: { type: 'notification:new'; id: string }): void {
    const set = sockets.get(userId);
    if (!set) return;
    const msg = JSON.stringify(event);
    for (const ws of set) {
      try {
        if (ws.readyState === ws.OPEN) ws.send(msg);
      } catch {
        // A broken socket isn't worth crashing the parent mutation over;
        // it'll be removed on close.
      }
    }
  },

  // For tests + introspection.
  size(userId?: string): number {
    if (userId) return sockets.get(userId)?.size ?? 0;
    let total = 0;
    for (const s of sockets.values()) total += s.size;
    return total;
  },
};

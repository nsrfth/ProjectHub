import { randomBytes, createHash } from 'node:crypto';

// v2.5.24 (W1.3): single-use, short-lived tickets for the notifications
// WebSocket upgrade — replaces the access-token-in-URL anti-pattern. A browser
// can't set an Authorization header on a WS upgrade, so the client exchanges
// its bearer token (over a normal authenticated POST /api/ws/ticket) for an
// opaque ticket, then opens the socket with `?ticket=<t>`. The ticket is
// consumed on first use (GETDEL semantics) and expires after TTL_MS.
//
// Storage is an in-memory Map keyed by sha256(ticket) — the raw ticket never
// rests in memory. This is deliberate for the single-replica deployment:
// tickets live ≤30s and the socket connects immediately after minting.
// [DEFAULT → deviation] the wave spec defaulted to Redis, but REDIS_URL is
// optional and NO Redis client is wired anywhere in the backend today, so an
// in-memory store is the proportionate choice. A multi-replica deployment would
// move this to Redis (`SET ticket:<hash> <userId> EX 30 NX` + GETDEL) so a
// ticket minted on one replica validates on another.

const TTL_MS = 30_000;

interface TicketEntry {
  userId: string;
  expiresAt: number;
}

function hashTicket(ticket: string): string {
  return createHash('sha256').update(ticket).digest('hex');
}

export class WsTicketStore {
  private store = new Map<string, TicketEntry>();

  /** Mint a fresh single-use ticket for a user. Returns the raw ticket. */
  issue(userId: string, now: number = Date.now()): string {
    this.purge(now);
    const ticket = randomBytes(32).toString('hex');
    this.store.set(hashTicket(ticket), { userId, expiresAt: now + TTL_MS });
    return ticket;
  }

  /**
   * Validate and atomically consume a ticket (single use). Returns the userId
   * on success, or null if the ticket is unknown, already used, or expired. The
   * entry is removed whether or not it was still valid, so a replay always fails.
   */
  consume(ticket: string | undefined | null, now: number = Date.now()): string | null {
    if (!ticket) return null;
    const key = hashTicket(ticket);
    const entry = this.store.get(key);
    if (!entry) return null;
    this.store.delete(key);
    if (entry.expiresAt <= now) return null;
    return entry.userId;
  }

  private purge(now: number): void {
    for (const [key, entry] of this.store) {
      if (entry.expiresAt <= now) this.store.delete(key);
    }
  }

  /** TTL in seconds, surfaced to the client so it knows how long it has to connect. */
  get ttlSeconds(): number {
    return TTL_MS / 1000;
  }
}

export const wsTicketStore = new WsTicketStore();

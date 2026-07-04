import { describe, it, expect } from 'vitest';
import { WsTicketStore } from '../../src/services/wsTicketService.js';

// W1.3: the security-critical logic behind the notifications WS ticket lives in
// the store (the route is thin glue). The socket upgrade itself needs a live TCP
// server, which this inject-only suite doesn't run — these unit tests cover the
// single-use + expiry + unknown-ticket guarantees the upgrade relies on.

describe('WsTicketStore (W1.3)', () => {
  it('issues a ticket that consumes once to the right user', () => {
    const s = new WsTicketStore();
    const t = s.issue('user-1');
    expect(s.consume(t)).toBe('user-1');
  });

  it('rejects a replayed (already-consumed) ticket — single use', () => {
    const s = new WsTicketStore();
    const t = s.issue('user-1');
    expect(s.consume(t)).toBe('user-1');
    expect(s.consume(t)).toBeNull();
  });

  it('rejects an unknown ticket (e.g. a raw access token in ?ticket=)', () => {
    const s = new WsTicketStore();
    s.issue('user-1');
    expect(s.consume('eyJhbGciOiJIUzI1NiJ9.not.a.ticket')).toBeNull();
    expect(s.consume(undefined)).toBeNull();
    expect(s.consume('')).toBeNull();
  });

  it('rejects an expired ticket', () => {
    const s = new WsTicketStore();
    const t = s.issue('user-1', 0); // expires at now + 30_000
    expect(s.consume(t, 30_001)).toBeNull();
  });

  it('stores only a hash — the raw ticket cannot be consumed from another store', () => {
    const s = new WsTicketStore();
    const t = s.issue('user-1');
    expect(new WsTicketStore().consume(t)).toBeNull();
  });

  it('exposes a 30s TTL', () => {
    expect(new WsTicketStore().ttlSeconds).toBe(30);
  });
});

import type { FastifyInstance } from 'fastify';
import { notificationsHub } from '../services/notificationsHub.js';

// Real-time notifications channel. Single endpoint:
//   GET /api/ws/notifications?token=<accessToken>
//
// Auth: short-lived access token in the query string. Putting tokens in URLs
// is a known anti-pattern (they end up in proxy logs), but browsers can't set
// custom headers on a WebSocket upgrade and the access token's 15-min TTL
// bounds the leak. Better protocols (ticket exchange, cookie + CSRF) are
// follow-ups, not v1.1.
//
// On message: server sends `{type:'notification:new'}` whenever a new row is
// written for this user. The client treats it as an invalidate signal and
// re-fetches /api/notifications via the normal REST endpoint.
export async function notificationsWsRoutes(app: FastifyInstance): Promise<void> {
  // @fastify/websocket v10: handler receives the WebSocket directly (the v9
  // `connection.socket` wrapper was removed).
  app.get('/notifications', { websocket: true }, (socket, req) => {
    const token = (req.query as { token?: string } | undefined)?.token;
    if (!token) {
      socket.send(JSON.stringify({ type: 'error', reason: 'missing token' }));
      socket.close(1008, 'unauthorized');
      return;
    }
    let userId: string;
    try {
      const payload = app.verifyAccess(token);
      userId = payload.sub;
    } catch {
      socket.send(JSON.stringify({ type: 'error', reason: 'invalid token' }));
      socket.close(1008, 'unauthorized');
      return;
    }

    const unsubscribe = notificationsHub.subscribe(userId, socket);
    socket.send(JSON.stringify({ type: 'subscribed' }));

    socket.on('close', () => {
      unsubscribe();
    });
    // We don't expect client-to-server messages on this channel. If one comes
    // in, ignore it — keeps the protocol surface minimal.
    socket.on('message', () => undefined);
  });
}

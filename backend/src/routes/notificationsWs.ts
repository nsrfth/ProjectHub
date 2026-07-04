import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { notificationsHub } from '../services/notificationsHub.js';
import { wsTicketStore } from '../services/wsTicketService.js';
import { requireAuth } from '../middleware/auth.js';

// Real-time notifications channel. Two endpoints, both under /api/ws:
//   POST /api/ws/ticket           — normal bearer auth; mints a single-use,
//                                    short-lived ticket (see wsTicketService).
//   GET  /api/ws/notifications?ticket=<t>  — the WebSocket upgrade.
//
// v2.5.24 (W1.3): auth is now a one-time ticket, NOT the access token in the
// query string. A browser can't set an Authorization header on a WS upgrade, so
// the client POSTs (authenticated) to mint an opaque ticket and opens the socket
// with it. This keeps credentials out of proxy/Caddy access logs; the previous
// `?token=<accessToken>` form is removed (the only consumer is our own frontend,
// and both ship together). Tickets are single-use and expire in ~30s.
//
// On message: server sends `{type:'notification:new'}` whenever a new row is
// written for this user. The client treats it as an invalidate signal and
// re-fetches /api/notifications via the normal REST endpoint.
export async function notificationsWsRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post('/ticket', {
    preHandler: requireAuth,
    schema: {
      tags: ['notifications'],
      summary: 'Mint a single-use WebSocket ticket (~30s TTL) for the notifications channel',
      response: {
        200: z.object({ ticket: z.string(), expiresInSec: z.number().int() }),
      },
      security: [{ bearerAuth: [] }],
    },
    handler: async (req) => {
      const ticket = wsTicketStore.issue(req.user!.sub);
      return { ticket, expiresInSec: wsTicketStore.ttlSeconds };
    },
  });

  // @fastify/websocket v10: handler receives the WebSocket directly (the v9
  // `connection.socket` wrapper was removed).
  app.get('/notifications', { websocket: true }, (socket, req) => {
    const ticket = (req.query as { ticket?: string } | undefined)?.ticket;
    const userId = wsTicketStore.consume(ticket);
    if (!userId) {
      socket.send(JSON.stringify({ type: 'error', reason: 'invalid or expired ticket' }));
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

import type { FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyJwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import type { Env } from '../config/env.js';
import { decorateJwt } from '../lib/jwt.js';

// Registers the cross-cutting security middleware. Order matters: helmet/cors
// before any route, rate-limit applied selectively in route files.
export async function registerSecurity(app: FastifyInstance, env: Env): Promise<void> {
  await app.register(helmet, {
    // The API serves JSON, no inline scripts. SPA is served by Caddy, not Fastify.
    contentSecurityPolicy: false,
  });

  await app.register(cors, {
    // Explicit allowlist. "*" with credentials is unsafe — fail loud if it slips in.
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // same-origin / curl
      if (env.corsOrigins.includes(origin)) return cb(null, true);
      cb(new Error('Origin not allowed'), false);
    },
    credentials: true,
  });

  await app.register(cookie);

  await app.register(rateLimit, {
    global: false, // applied per-route on auth endpoints
    max: env.AUTH_RATE_LIMIT_MAX,
    timeWindow: env.AUTH_RATE_LIMIT_WINDOW,
  });

  // Access token plugin.
  await app.register(fastifyJwt, {
    secret: env.JWT_ACCESS_SECRET,
    sign: { expiresIn: env.JWT_ACCESS_TTL },
  });

  // Separate plugin instance for refresh tokens, namespaced so it doesn't shadow
  // the default `app.jwt`. Different secret => leaked access secret can't mint refresh tokens.
  await app.register(fastifyJwt, {
    secret: env.JWT_REFRESH_SECRET,
    namespace: 'refresh',
    decoratorName: 'jwtRefreshUser',
    jwtVerify: 'jwtRefreshVerify',
    jwtSign: 'jwtRefreshSign',
  } as any);

  // The refresh-namespaced plugin exposes `app.jwtRefresh` for sign/verify.
  decorateJwt(app, env.JWT_ACCESS_TTL);

  // Multipart for attachment uploads. The hard byte limit is enforced by the
  // plugin via `limits.fileSize`; payloads that exceed it stream until the
  // limit then the request's `file.truncated` flag is set so the route can
  // 413. Single-file uploads only — multiple-file payloads are rejected.
  await app.register(multipart, {
    limits: {
      fileSize: env.UPLOAD_MAX_BYTES,
      files: 1,
      // Field name + value sizes — small but defensive against a junk client.
      fieldNameSize: 100,
      fieldSize: 1024,
    },
  });
}

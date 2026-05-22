// Thin wrapper around @fastify/jwt that provides typed access + refresh signers
// with separate secrets so a leaked access secret can't mint refresh tokens.
import type { FastifyInstance } from 'fastify';
import type { GlobalRole } from '@prisma/client';

export interface AccessTokenPayload {
  sub: string; // user id
  email: string;
  globalRole: GlobalRole;
  // Team scoping is fetched per-request from the DB, not embedded — keeps tokens
  // small and ensures revoked memberships take effect immediately.
}

export interface RefreshTokenPayload {
  sub: string;
  jti: string; // matches RefreshToken.id in DB
}

declare module 'fastify' {
  interface FastifyInstance {
    signAccess(payload: AccessTokenPayload): string;
    verifyAccess(token: string): AccessTokenPayload;
    signRefresh(payload: RefreshTokenPayload, expiresIn: string): string;
    verifyRefresh(token: string): RefreshTokenPayload;
  }
}

// @fastify/jwt owns the FastifyRequest.user declaration. Augmenting its
// FastifyJWT.user interface here propagates AccessTokenPayload to request.user
// (and to fastify.jwt.sign payload typing) without a conflicting redeclaration.
declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AccessTokenPayload;
    user: AccessTokenPayload;
  }
}

export function decorateJwt(app: FastifyInstance, accessTtl: string): void {
  app.decorate('signAccess', (payload: AccessTokenPayload) =>
    app.jwt.sign(payload, { expiresIn: accessTtl }),
  );
  app.decorate('verifyAccess', (token: string) => app.jwt.verify(token) as AccessTokenPayload);
  // @fastify/jwt v8 exposes namespaced instances at `app.jwt.<namespace>`, not
  // `app.<namespace>`. The plugin in security.ts registers with namespace 'refresh',
  // so the sign/verify functions live on app.jwt.refresh. Assert it's present so
  // a misconfiguration crashes at startup, not on the first login.
  const refreshJwt = (app.jwt as unknown as Record<string, { sign: (p: object, opts: object) => string; verify: (t: string) => unknown } | undefined>).refresh;
  if (!refreshJwt) throw new Error('Refresh JWT namespace not registered — check plugins/security.ts');
  app.decorate('signRefresh', (payload: RefreshTokenPayload, expiresIn: string) =>
    refreshJwt.sign(payload, { expiresIn }),
  );
  app.decorate('verifyRefresh', (token: string) => refreshJwt.verify(token) as RefreshTokenPayload);
}

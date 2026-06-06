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

// Short-lived intermediate token issued after a correct password but before
// the second factor. Carrying its own `kind` claim makes it impossible to
// replay as a normal access token even though it's signed with the same key.
export interface PendingTokenPayload {
  sub: string;
  kind: '2fa-pending';
}

declare module 'fastify' {
  interface FastifyInstance {
    signAccess(payload: AccessTokenPayload): string;
    verifyAccess(token: string): AccessTokenPayload;
    signRefresh(payload: RefreshTokenPayload, expiresIn: string): string;
    verifyRefresh(token: string): RefreshTokenPayload;
    signPending(sub: string): string;
    verifyPending(token: string): PendingTokenPayload;
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
  // v1.30.1 (S-3): reject any token carrying a `kind` claim. Pending-2FA
  // tokens set kind:'2fa-pending'; real access tokens have no kind. Without
  // this guard a pending token — signed with the same secret — would pass
  // requireAuth and let an attacker who phished a password-only login skip
  // the second factor (and, worse, mint an API token via /settings/api-tokens,
  // turning a 5-minute pending window into a long-lived takeover). The
  // route layer still calls verifyPending() to consume pending tokens at
  // /auth/2fa/login; that path is unaffected because it doesn't go through
  // verifyAccess.
  app.decorate('verifyAccess', (token: string) => {
    const payload = app.jwt.verify(token) as AccessTokenPayload & { kind?: unknown };
    if (payload && typeof payload === 'object' && 'kind' in payload && payload.kind !== undefined) {
      throw new Error('Token is not an access token');
    }
    return payload;
  });
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

  // Pending-2FA tokens reuse the access secret so we don't need a separate
  // env var. The 5-minute TTL bounds the replay window. The `kind` claim is
  // BOTH the route-level discriminator (verifyPending checks it explicitly)
  // AND a guard in verifyAccess: any token with a `kind` claim is rejected,
  // so a pending token can never satisfy requireAuth. (S-3 patched in v1.30.1.)
  app.decorate('signPending', (sub: string) =>
    app.jwt.sign({ sub, kind: '2fa-pending' } as unknown as AccessTokenPayload, { expiresIn: '5m' }),
  );
  app.decorate('verifyPending', (token: string) => {
    const payload = app.jwt.verify(token) as unknown as PendingTokenPayload;
    if (payload?.kind !== '2fa-pending') {
      throw new Error('Not a 2FA-pending token');
    }
    return payload;
  });
}

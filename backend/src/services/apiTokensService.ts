import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';
import { randomTokenHex, sha256 } from '../lib/hashing.js';

// Per-user API tokens. Raw token shape: `th_<48-hex>`. The `th_` prefix is
// the cheap-to-recognise marker the auth middleware uses to branch into the
// API-token path instead of JWT verification. Only sha256(rawToken) persists.

const TOKEN_PREFIX = 'th_';
const PREFIX_DISPLAY_LEN = TOKEN_PREFIX.length + 8; // e.g. "th_a1b2c3d4"

export interface ApiTokenView {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

function toView(row: {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}): ApiTokenView {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
  };
}

export class ApiTokensService {
  // List tokens belonging to a single user. Revoked + expired tokens stay in
  // the list so the user can audit recent activity ("when was this used last").
  async list(ownerId: string): Promise<ApiTokenView[]> {
    const rows = await prisma.apiToken.findMany({
      where: { ownerId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toView);
  }

  async generate(
    ownerId: string,
    input: { name: string; scopes: string[]; expiresAt?: Date | null },
  ): Promise<{ view: ApiTokenView; rawToken: string }> {
    const rawToken = `${TOKEN_PREFIX}${randomTokenHex(24)}`; // 48 hex chars = 192 bits
    const tokenHash = sha256(rawToken);
    const prefix = rawToken.slice(0, PREFIX_DISPLAY_LEN);
    const row = await prisma.apiToken.create({
      data: {
        ownerId,
        name: input.name,
        prefix,
        tokenHash,
        scopes: input.scopes,
        expiresAt: input.expiresAt ?? null,
      },
    });
    return { view: toView(row), rawToken };
  }

  // Soft revoke — keeps the row for audit. Future verifies fail because
  // verify() rejects revokedAt != null.
  async revoke(ownerId: string, tokenId: string): Promise<void> {
    const row = await prisma.apiToken.findUnique({ where: { id: tokenId } });
    if (!row || row.ownerId !== ownerId) throw Errors.notFound('Token not found');
    if (row.revokedAt) return;
    await prisma.apiToken.update({
      where: { id: tokenId },
      data: { revokedAt: new Date() },
    });
  }

  // Verify a raw bearer string. Returns the owner + scopes when valid, or
  // null otherwise. Touches lastUsedAt as a best-effort diagnostic — never
  // blocks verification on the write succeeding.
  async verify(rawToken: string): Promise<{ ownerId: string; scopes: string[] } | null> {
    if (!rawToken || !rawToken.startsWith(TOKEN_PREFIX)) return null;
    const tokenHash = sha256(rawToken);
    const row = await prisma.apiToken.findUnique({ where: { tokenHash } });
    if (!row || row.revokedAt) return null;
    if (row.expiresAt && row.expiresAt < new Date()) return null;
    prisma.apiToken
      .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);
    return { ownerId: row.ownerId, scopes: row.scopes };
  }

  // Quick check used by the auth middleware to avoid a DB roundtrip for
  // tokens that obviously aren't API tokens (JWTs look like base64,
  // starting with "ey").
  isApiTokenShape(raw: string): boolean {
    return raw.startsWith(TOKEN_PREFIX);
  }
}

export const _TOKEN_PREFIX_FOR_TESTS = TOKEN_PREFIX;

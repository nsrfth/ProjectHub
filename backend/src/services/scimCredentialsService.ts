import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';
import { randomTokenHex, sha256 } from '../lib/hashing.js';

// One ScimCredential per Directory. The raw bearer token is generated server-
// side, returned ONCE to the admin, then only its sha256 hash is persisted.
// `verify` is constant-time-comparable because lookup is by hash, not by
// scanning rows.

export interface ScimCredentialView {
  id: string;
  directoryId: string;
  name: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

function toView(row: {
  id: string;
  directoryId: string;
  name: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}): ScimCredentialView {
  return {
    id: row.id,
    directoryId: row.directoryId,
    name: row.name,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
  };
}

export class ScimCredentialsService {
  // Show the existing credential for a directory, if any. Never includes
  // the raw token — only `generate` ever returns that.
  async get(directoryId: string): Promise<ScimCredentialView | null> {
    const row = await prisma.scimCredential.findUnique({ where: { directoryId } });
    return row ? toView(row) : null;
  }

  // Create or rotate. If a credential already exists, it is overwritten —
  // the previous raw token is permanently invalidated. Returns the raw token
  // so the controller can show it to the admin ONCE.
  async generate(directoryId: string, name: string): Promise<{ view: ScimCredentialView; rawToken: string }> {
    // Validate directory exists.
    const dir = await prisma.directory.findUnique({ where: { id: directoryId } });
    if (!dir) throw Errors.notFound('Directory not found');

    const rawToken = randomTokenHex(32); // 64 hex chars, ~256 bits.
    const tokenHash = sha256(rawToken);

    const row = await prisma.scimCredential.upsert({
      where: { directoryId },
      update: { tokenHash, name, revokedAt: null, lastUsedAt: null },
      create: { directoryId, tokenHash, name },
    });

    return { view: toView(row), rawToken };
  }

  // Soft-revoke — flips revokedAt but keeps the row for audit. Future
  // verifications fail because the hash check additionally requires
  // revokedAt IS NULL.
  async revoke(directoryId: string): Promise<void> {
    const row = await prisma.scimCredential.findUnique({ where: { directoryId } });
    if (!row) throw Errors.notFound('No SCIM credential for this directory');
    if (row.revokedAt) return; // Idempotent.
    await prisma.scimCredential.update({
      where: { directoryId },
      data: { revokedAt: new Date() },
    });
  }

  // Verify a Bearer token from an inbound SCIM request. Returns the
  // directoryId on success, null otherwise. Touches `lastUsedAt` as a
  // diagnostic aid — not as security state.
  async verify(rawToken: string): Promise<string | null> {
    if (!rawToken) return null;
    const tokenHash = sha256(rawToken);
    const row = await prisma.scimCredential.findUnique({ where: { tokenHash } });
    if (!row || row.revokedAt) return null;
    // Best-effort update; failure here is not fatal.
    prisma.scimCredential
      .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);
    return row.directoryId;
  }
}

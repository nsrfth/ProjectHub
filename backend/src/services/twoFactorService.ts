import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { sha256 } from '../lib/hashing.js';
import {
  generateRecoveryCodes,
  generateSecret,
  normaliseRecoveryCode,
  provisioningQrDataUrl,
  provisioningUri,
  verifyTotp,
} from '../lib/totp.js';

// Two-factor enrollment + verification. Designed so the user can't
// "accidentally" lock themselves out: the secret is only persisted after a
// successful code-confirm round-trip, and recovery codes are returned
// (once) as part of the same confirm response.

export interface TwoFactorSetup {
  secret: string;        // base32, displayed under the QR for manual entry.
  uri: string;           // otpauth:// — sometimes shown for debug / copy.
  qrDataUrl: string;     // PNG data URL, rendered inline in the UI.
}

export interface TwoFactorConfirmResult {
  recoveryCodes: string[]; // Plaintext — surfaced ONCE here.
}

export class TwoFactorService {
  // Build setup material. Does NOT persist anything — the secret only
  // touches the DB at confirmSetup, encrypted with the MASTER_KEY.
  // Two consecutive calls return different secrets; the latest one wins
  // when confirmSetup completes.
  async setup(userId: string): Promise<TwoFactorSetup> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw Errors.notFound('User not found');
    if (user.totpEnabled) throw Errors.conflict('2FA is already enabled');

    const secret = generateSecret();
    const uri = provisioningUri(secret, user.email);
    const qrDataUrl = await provisioningQrDataUrl(secret, user.email);
    return { secret, uri, qrDataUrl };
  }

  // Verify the first TOTP code typed by the user; on success, persist the
  // encrypted secret, flip totpEnabled, and generate + hash recovery codes.
  // The plaintext recovery codes are returned to the caller and never
  // surface again.
  async confirmSetup(
    userId: string,
    secret: string,
    code: string,
  ): Promise<TwoFactorConfirmResult> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw Errors.notFound('User not found');
    if (user.totpEnabled) throw Errors.conflict('2FA is already enabled');
    if (!verifyTotp(code, secret)) throw Errors.badRequest('Invalid code');

    const codes = generateRecoveryCodes();
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          totpSecretEnc: encrypt(secret),
          totpEnabled: true,
        },
      });
      // Wipe any pre-existing recovery codes — paranoid; nothing should
      // have created them yet, but a defensive reset here costs nothing.
      await tx.recoveryCode.deleteMany({ where: { userId } });
      await tx.recoveryCode.createMany({
        data: codes.map((c) => ({ userId, codeHash: sha256(normaliseRecoveryCode(c)) })),
      });
    });
    return { recoveryCodes: codes };
  }

  // Disable 2FA. Requires a fresh proof-of-control: the user must supply a
  // current TOTP code OR a recovery code. This prevents a stolen
  // access-token from disarming 2FA without the second factor.
  async disable(userId: string, proof: string): Promise<void> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw Errors.notFound('User not found');
    if (!user.totpEnabled || !user.totpSecretEnc) {
      throw Errors.badRequest('2FA is not enabled');
    }
    const ok = await this.verifyProof(userId, user.totpSecretEnc, proof);
    if (!ok) throw Errors.badRequest('Invalid code');
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { totpEnabled: false, totpSecretEnc: null },
      });
      await tx.recoveryCode.deleteMany({ where: { userId } });
    });
  }

  // Regenerate recovery codes — invalidates the entire previous set. Used
  // when the user has consumed several and wants a fresh batch, or has
  // misplaced the printout. Returns the new plaintext codes ONCE.
  async regenerateRecoveryCodes(userId: string): Promise<string[]> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw Errors.notFound('User not found');
    if (!user.totpEnabled) throw Errors.badRequest('2FA is not enabled');

    const codes = generateRecoveryCodes();
    await prisma.$transaction(async (tx) => {
      await tx.recoveryCode.deleteMany({ where: { userId } });
      await tx.recoveryCode.createMany({
        data: codes.map((c) => ({ userId, codeHash: sha256(normaliseRecoveryCode(c)) })),
      });
    });
    return codes;
  }

  // Login-time verification. Accepts a TOTP code OR a recovery code; the
  // recovery path burns the row on first use. Returns true iff one of
  // them matched.
  async verifyForLogin(userId: string, proof: string): Promise<boolean> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.totpEnabled || !user.totpSecretEnc) return false;
    return this.verifyProof(userId, user.totpSecretEnc, proof);
  }

  // ── internal ─────────────────────────────────────────────────────────
  private async verifyProof(
    userId: string,
    totpSecretEnc: string,
    proof: string,
  ): Promise<boolean> {
    // 6-digit numeric input → TOTP path.
    if (/^\d{6}$/.test(proof)) {
      const secret = decrypt(totpSecretEnc);
      return verifyTotp(proof, secret);
    }
    // Otherwise treat as recovery code — normalise, hash, look up + burn.
    const normalised = normaliseRecoveryCode(proof);
    if (normalised.length < 4) return false; // Plainly bogus input.
    const codeHash = sha256(normalised);
    const row = await prisma.recoveryCode.findUnique({ where: { codeHash } });
    if (!row || row.userId !== userId || row.usedAt) return false;
    await prisma.recoveryCode.update({
      where: { id: row.id },
      data: { usedAt: new Date() },
    });
    return true;
  }
}

import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import crypto from 'node:crypto';

// TOTP helpers. We use otplib's defaults (SHA-1, 6 digits, 30s window) which
// matches every mainstream authenticator app (Google Authenticator, Authy,
// 1Password, Bitwarden, …). A ±1 window tolerates 30 seconds of clock skew
// on either side.
authenticator.options = {
  digits: 6,
  step: 30,
  window: 1,
};

// Issuer + label make the authenticator app show "TaskHub (email)" rather
// than a bare key fingerprint.
const ISSUER = 'TaskHub';

// Generate a fresh base32 secret. otplib serialises this to the format
// authenticator apps expect.
export function generateSecret(): string {
  return authenticator.generateSecret();
}

// Build the otpauth:// URI an authenticator scans. The label MUST be URL-safe;
// otplib handles that internally.
export function provisioningUri(secret: string, accountEmail: string): string {
  return authenticator.keyuri(accountEmail, ISSUER, secret);
}

// Render the provisioning URI as a PNG data URL. The frontend renders this
// in an <img> tag — no client-side QR library needed.
export async function provisioningQrDataUrl(secret: string, accountEmail: string): Promise<string> {
  const uri = provisioningUri(secret, accountEmail);
  return QRCode.toDataURL(uri, { errorCorrectionLevel: 'M', margin: 1, width: 220 });
}

// Verify a 6-digit code against the stored secret. Wraps otplib so callers
// don't depend on its API directly.
export function verifyTotp(code: string, secret: string): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  try {
    return authenticator.verify({ token: code, secret });
  } catch {
    return false;
  }
}

// Recovery codes — 10 by default. Format: "xxxx-xxxx-xxxx-xxxx" (16 hex chars,
// 64 bits of entropy each). Easy to type, hard to enumerate. The dashes are
// purely cosmetic — normaliseRecoveryCode strips non-hex during verification
// so users typing the raw 16 chars (or any grouping) also work.
export function generateRecoveryCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const buf = crypto.randomBytes(8).toString('hex'); // 64 bits
    codes.push(`${buf.slice(0, 4)}-${buf.slice(4, 8)}-${buf.slice(8, 12)}-${buf.slice(12, 16)}`);
  }
  return codes;
}

// Normalise a user-entered recovery code (lowercase + strip non-hex) before
// hashing or comparing. Lets users paste "ABCD-EFGH" or "abcdefgh" and have
// both work.
export function normaliseRecoveryCode(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-f0-9]/g, '');
}

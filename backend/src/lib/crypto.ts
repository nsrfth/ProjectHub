import crypto from 'node:crypto';

// AES-256-GCM symmetric encryption for at-rest integration secrets.
//
// Format of an encrypted string: base64(iv || ciphertext || authTag).
//   iv         12 bytes — random per encryption.
//   ciphertext n bytes  — same length as plaintext.
//   authTag    16 bytes — GCM authentication tag.
//
// All three subsystems that need at-rest crypto (LDAP bind passwords, TOTP
// secrets, webhook secrets) share one MASTER_KEY. Loss of the key means loss
// of every encrypted value: there is no recovery path. Operators must back
// up the .env separately from the database.

const IV_LEN = 12;
const TAG_LEN = 16;
const ALGO = 'aes-256-gcm' as const;

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const hex = process.env.MASTER_KEY;
  if (!hex) {
    throw new Error(
      'MASTER_KEY is not set. Generate one with: ' +
        '`node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"` ' +
        'and set it in .env before using LDAP, TOTP, or webhook secrets.',
    );
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('MASTER_KEY must be 64 hex chars (32 bytes).');
  }
  cachedKey = Buffer.from(hex, 'hex');
  return cachedKey;
}

// Encrypt a plaintext string. Returns base64. Idempotent in the sense that
// calling twice produces different ciphertexts (random IV), both decrypting
// to the same plaintext — that's the desired property.
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString('base64');
}

// Decrypt a base64 ciphertext produced by encrypt(). Throws on tampered
// input (GCM auth-tag mismatch) or wrong key — callers should treat any
// failure as "secret is unrecoverable" and either re-prompt or surface a
// 5xx, never a 4xx that leaks state.
export function decrypt(b64: string): string {
  const key = getKey();
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < IV_LEN + TAG_LEN) {
    throw new Error('Ciphertext too short — not produced by encrypt().');
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ct = buf.subarray(IV_LEN, buf.length - TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// Test hook — lets unit tests reset the cache between runs.
export function _resetKeyCacheForTests(): void {
  cachedKey = null;
}

import argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';

// argon2id is the modern OWASP-recommended default for password hashing.
const ARGON2_OPTS = {
  type: argon2.argon2id,
  // Defaults are sane for a small server. Bump memoryCost on beefier hardware.
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, ARGON2_OPTS);
}

export function verifyPassword(hash: string, plain: string): Promise<boolean> {
  return argon2.verify(hash, plain);
}

// Refresh tokens and password-reset tokens are stored as SHA-256 hashes so a DB
// leak can't be replayed against the API.
export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function randomTokenHex(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

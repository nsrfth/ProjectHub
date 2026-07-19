// Configurable local-user password policy. Stored in InstanceSetting
// `security.passwordPolicy`; defaults mirror the pre-v1.43 hardcoded rules.

import { randomInt } from 'node:crypto';

export interface PasswordPolicy {
  minLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireNumbers: boolean;
  requireSpecialChars: boolean;
  passwordExpirationDays: number;
  passwordHistoryCount: number;
  minPasswordAgeDays: number;
  maxFailedLoginAttempts: number;
  lockoutDurationMinutes: number;
  preventCommonPasswords: boolean;
  preventUsernameInPassword: boolean;
}

export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  minLength: 12,
  requireUppercase: false,
  requireLowercase: true,
  requireNumbers: true,
  requireSpecialChars: false,
  passwordExpirationDays: 0,
  passwordHistoryCount: 0,
  minPasswordAgeDays: 0,
  maxFailedLoginAttempts: 0,
  lockoutDurationMinutes: 15,
  preventCommonPasswords: true,
  preventUsernameInPassword: true,
};

const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '123456', '12345678', '123456789',
  'qwerty', 'abc123', 'monkey', 'letmein', 'welcome', 'admin', 'login',
  'passw0rd', 'iloveyou', 'sunshine', 'princess', 'football', 'dragon',
  'baseball', 'master', 'hello', 'freedom', 'whatever', 'qazwsx', 'trustno1',
]);

export function normalizePasswordPolicy(raw: unknown): PasswordPolicy {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<PasswordPolicy>;
  const minLength = Number(o.minLength);
  return {
    minLength: Number.isInteger(minLength) && minLength >= 6 && minLength <= 128
      ? minLength
      : DEFAULT_PASSWORD_POLICY.minLength,
    requireUppercase: o.requireUppercase === true,
    requireLowercase: o.requireLowercase !== false,
    requireNumbers: o.requireNumbers !== false,
    requireSpecialChars: o.requireSpecialChars === true,
    passwordExpirationDays: clampInt(o.passwordExpirationDays, 0, 3650, 0),
    passwordHistoryCount: clampInt(o.passwordHistoryCount, 0, 24, 0),
    minPasswordAgeDays: clampInt(o.minPasswordAgeDays, 0, 365, 0),
    maxFailedLoginAttempts: clampInt(o.maxFailedLoginAttempts, 0, 100, 0),
    lockoutDurationMinutes: clampInt(o.lockoutDurationMinutes, 1, 1440, 15),
    preventCommonPasswords: o.preventCommonPasswords !== false,
    preventUsernameInPassword: o.preventUsernameInPassword !== false,
  };
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export interface PasswordValidationContext {
  email?: string;
  name?: string;
}

export function validatePasswordAgainstPolicy(
  password: string,
  policy: PasswordPolicy,
  ctx: PasswordValidationContext = {},
): string | null {
  if (password.length < policy.minLength) {
    return `Password must be at least ${policy.minLength} characters`;
  }
  if (password.length > 200) return 'Password is too long';
  if (policy.requireUppercase && !/[A-Z]/.test(password)) {
    return 'Password must contain at least one uppercase letter';
  }
  if (policy.requireLowercase && !/[a-z]/.test(password)) {
    return 'Password must contain at least one lowercase letter';
  }
  if (policy.requireNumbers && !/\d/.test(password)) {
    return 'Password must contain at least one number';
  }
  if (policy.requireSpecialChars && !/[^A-Za-z0-9]/.test(password)) {
    return 'Password must contain at least one special character';
  }
  if (policy.preventCommonPasswords && COMMON_PASSWORDS.has(password.toLowerCase())) {
    return 'Password is too common — choose a stronger password';
  }
  if (policy.preventUsernameInPassword && ctx.email) {
    const local = ctx.email.split('@')[0]?.toLowerCase();
    if (local && local.length >= 3 && password.toLowerCase().includes(local)) {
      return 'Password must not contain your username or email';
    }
  }
  return null;
}

export type PasswordStrength = 'weak' | 'fair' | 'good' | 'strong';

export function scorePasswordStrength(password: string, policy: PasswordPolicy): PasswordStrength {
  let score = 0;
  if (password.length >= policy.minLength) score++;
  if (password.length >= policy.minLength + 4) score++;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
  if (/\d/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;
  if (password.length >= 16) score++;
  if (score <= 2) return 'weak';
  if (score <= 3) return 'fair';
  if (score <= 4) return 'good';
  return 'strong';
}

// Draw one character uniformly from `s` using a CSPRNG. `randomInt` is
// rejection-sampled internally, so there is no modulo bias.
function randomChar(s: string): string {
  return s[randomInt(s.length)]!;
}

export function generateCompliantPassword(policy: PasswordPolicy): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const special = '!@#$%^&*-_+=';
  // Always include lowercase + digits; add the optionally-required classes.
  // These server-generated values are handed to a user as their live
  // credential, so entropy MUST come from a CSPRNG (crypto.randomInt), never
  // Math.random() — the latter is state-recoverable and, with the old fixed
  // "a2…" prefix, made the whole password guessable.
  let pool = lower + digits;
  const required: string[] = [randomChar(lower), randomChar(digits)];
  if (policy.requireUppercase) {
    pool += upper;
    required.push(randomChar(upper));
  }
  if (policy.requireSpecialChars) {
    pool += special;
    required.push(randomChar(special));
  }
  const target = Math.max(policy.minLength, 16);
  const chars = [...required];
  while (chars.length < target) {
    chars.push(randomChar(pool));
  }
  // Fisher–Yates shuffle so the required-class characters aren't pinned to
  // fixed leading positions (which would leak structure to an attacker).
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}

export function policyRequirementLines(policy: PasswordPolicy): string[] {
  const lines: string[] = [`At least ${policy.minLength} characters`];
  if (policy.requireUppercase) lines.push('At least one uppercase letter');
  if (policy.requireLowercase) lines.push('At least one lowercase letter');
  if (policy.requireNumbers) lines.push('At least one number');
  if (policy.requireSpecialChars) lines.push('At least one special character');
  if (policy.preventCommonPasswords) lines.push('Not a common password');
  if (policy.preventUsernameInPassword) lines.push('Must not contain your email/username');
  return lines;
}

import { api } from '@/lib/api';

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

export interface PublicPasswordPolicy {
  policy: PasswordPolicy;
  requirements: string[];
}

export async function fetchPublicPasswordPolicy(): Promise<PublicPasswordPolicy> {
  return (await api.get<PublicPasswordPolicy>('/system/password-policy')).data;
}

export async function fetchAdminPasswordPolicy(): Promise<PasswordPolicy> {
  return (await api.get<PasswordPolicy>('/settings/security/password-policy')).data;
}

export async function updateAdminPasswordPolicy(policy: PasswordPolicy): Promise<PasswordPolicy> {
  return (await api.put<PasswordPolicy>('/settings/security/password-policy', policy)).data;
}

export function scorePasswordStrength(
  password: string,
  policy: PasswordPolicy,
): 'weak' | 'fair' | 'good' | 'strong' {
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

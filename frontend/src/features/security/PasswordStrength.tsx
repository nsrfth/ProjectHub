import { useQuery } from '@tanstack/react-query';
import {
  fetchPublicPasswordPolicy,
  scorePasswordStrength,
  type PasswordPolicy,
} from './passwordPolicyApi';

const STRENGTH_CLASS: Record<string, string> = {
  weak: 'text-red-600',
  fair: 'text-amber-600',
  good: 'text-blue-600',
  strong: 'text-emerald-600',
};

export function PasswordRequirements({
  policy,
}: {
  policy: PasswordPolicy;
}): JSX.Element {
  const lines: string[] = [`Minimum ${policy.minLength} characters`];
  if (policy.requireUppercase) lines.push('Uppercase letter');
  if (policy.requireLowercase) lines.push('Lowercase letter');
  if (policy.requireNumbers) lines.push('Number');
  if (policy.requireSpecialChars) lines.push('Special character');
  if (policy.preventCommonPasswords) lines.push('Not a common password');
  if (policy.preventUsernameInPassword) lines.push('Must not contain your email/username');

  return (
    <ul className="text-xs text-slate-500 list-disc list-inside space-y-0.5">
      {lines.map((l) => (
        <li key={l}>{l}</li>
      ))}
    </ul>
  );
}

export function PasswordStrengthIndicator({
  password,
}: {
  password: string;
}): JSX.Element | null {
  const { data } = useQuery({
    queryKey: ['system', 'password-policy'],
    queryFn: fetchPublicPasswordPolicy,
    staleTime: 60_000,
  });
  if (!password || !data) return null;
  const strength = scorePasswordStrength(password, data.policy);
  return (
    <div className="mt-1 text-xs">
      <span className="text-slate-500">Strength: </span>
      <span className={`font-medium capitalize ${STRENGTH_CLASS[strength]}`}>{strength}</span>
    </div>
  );
}

export function PasswordPolicyHints(): JSX.Element | null {
  const { data } = useQuery({
    queryKey: ['system', 'password-policy'],
    queryFn: fetchPublicPasswordPolicy,
    staleTime: 60_000,
  });
  if (!data) return null;
  return (
    <div className="mt-2">
      <p className="text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
        Password requirements
      </p>
      <PasswordRequirements policy={data.policy} />
    </div>
  );
}

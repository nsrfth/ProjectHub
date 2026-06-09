import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';
import {
  DEFAULT_PASSWORD_POLICY,
  normalizePasswordPolicy,
  policyRequirementLines,
  scorePasswordStrength,
  validatePasswordAgainstPolicy,
  type PasswordPolicy,
  type PasswordStrength,
  type PasswordValidationContext,
} from '../lib/passwordPolicy.js';
import { verifyPassword } from '../lib/hashing.js';
import { InstanceSettingsService } from './instanceSettingsService.js';
import { securityAudit } from './securityAuditService.js';

const POLICY_KEY = 'security.passwordPolicy';

export class PasswordPolicyService {
  private readonly settings = new InstanceSettingsService();

  async getPolicy(): Promise<PasswordPolicy> {
    const row = await this.settings.get(POLICY_KEY);
    return normalizePasswordPolicy(row?.value);
  }

  async getPublicPolicyView(): Promise<{
    policy: PasswordPolicy;
    requirements: string[];
  }> {
    const policy = await this.getPolicy();
    return { policy, requirements: policyRequirementLines(policy) };
  }

  async updatePolicy(actorId: string, raw: unknown): Promise<PasswordPolicy> {
    const previous = await this.getPolicy();
    const policy = normalizePasswordPolicy(raw);
    await this.settings.set(POLICY_KEY, policy, actorId);
    await securityAudit.log('password_policy.updated', actorId, {
      previous,
      next: policy,
    });
    return policy;
  }

  validate(
    password: string,
    ctx: PasswordValidationContext = {},
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    return this.getPolicy().then((policy) => {
      const message = validatePasswordAgainstPolicy(password, policy, ctx);
      return message ? { ok: false as const, message } : { ok: true as const };
    });
  }

  async assertValid(
    password: string,
    ctx: PasswordValidationContext = {},
  ): Promise<void> {
    const result = await this.validate(password, ctx);
    if (!result.ok) throw Errors.badRequest(result.message);
  }

  strength(password: string, policy?: PasswordPolicy): Promise<PasswordStrength> {
    const p = policy ?? this.getPolicy();
    return Promise.resolve(p).then((pol) => scorePasswordStrength(password, pol));
  }

  async assertNotReused(userId: string, newPassword: string): Promise<void> {
    const policy = await this.getPolicy();
    if (policy.passwordHistoryCount <= 0) return;

    const rows = await prisma.passwordHistory.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: policy.passwordHistoryCount,
      select: { passwordHash: true },
    });
    for (const row of rows) {
      if (await verifyPassword(row.passwordHash, newPassword)) {
        throw Errors.badRequest('Password was used recently — choose a different password');
      }
    }
  }

  async assertMinAge(userId: string): Promise<void> {
    const policy = await this.getPolicy();
    if (policy.minPasswordAgeDays <= 0) return;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { passwordChangedAt: true },
    });
    if (!user?.passwordChangedAt) return;
    const minMs = policy.minPasswordAgeDays * 24 * 60 * 60 * 1000;
    if (Date.now() - user.passwordChangedAt.getTime() < minMs) {
      throw Errors.badRequest(
        `Password cannot be changed yet — minimum age is ${policy.minPasswordAgeDays} day(s)`,
      );
    }
  }

  async recordPasswordChange(userId: string, passwordHash: string): Promise<void> {
    const policy = await this.getPolicy();
    const now = new Date();
    await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: { passwordHash, passwordChangedAt: now, failedLoginAttempts: 0, lockedUntil: null },
      }),
      prisma.passwordHistory.create({ data: { userId, passwordHash } }),
    ]);
    if (policy.passwordHistoryCount > 0) {
      const keep = await prisma.passwordHistory.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: policy.passwordHistoryCount,
        select: { id: true },
      });
      const keepIds = new Set(keep.map((r) => r.id));
      const all = await prisma.passwordHistory.findMany({
        where: { userId },
        select: { id: true },
      });
      const remove = all.filter((r) => !keepIds.has(r.id)).map((r) => r.id);
      if (remove.length) {
        await prisma.passwordHistory.deleteMany({ where: { id: { in: remove } } });
      }
    }
  }

  isPasswordExpired(passwordChangedAt: Date | null): Promise<boolean> {
    return this.getPolicy().then((policy) => {
      if (policy.passwordExpirationDays <= 0 || !passwordChangedAt) return false;
      const maxMs = policy.passwordExpirationDays * 24 * 60 * 60 * 1000;
      return Date.now() - passwordChangedAt.getTime() > maxMs;
    });
  }
}

export const passwordPolicyService = new PasswordPolicyService();

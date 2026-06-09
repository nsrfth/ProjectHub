import { prisma } from '../data/prisma.js';

export type SecurityAuditKind =
  | 'password_policy.updated'
  | 'server.port.changed'
  | 'ssl.https.toggled'
  | 'ssl.certificate.uploaded'
  | 'ssl.private_key.uploaded'
  | 'ssl.chain.uploaded';

export class SecurityAuditService {
  async log(
    kind: SecurityAuditKind,
    actorId: string | null,
    details: Record<string, unknown>,
  ): Promise<void> {
    try {
      await prisma.securityAuditEvent.create({
        data: { kind, actorId, details: details as never },
      });
    } catch {
      // Best-effort — never block the admin action on audit failure.
    }
  }
}

export const securityAudit = new SecurityAuditService();

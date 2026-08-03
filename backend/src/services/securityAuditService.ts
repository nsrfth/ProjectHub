import { prisma } from '../data/prisma.js';

export type SecurityAuditKind =
  | 'password_policy.updated'
  | 'server.port.changed'
  | 'ssl.https.toggled'
  | 'ssl.certificate.uploaded'
  | 'ssl.private_key.uploaded'
  | 'ssl.chain.uploaded'
  // v2.23.3 (S-13): backup restore recovery. `rolled_back` = the requested
  // restore failed and the automatic safety dump was put back; `fatal` =
  // both failed and a human must intervene (maintenance mode stays on).
  | 'backup.restore.rolled_back'
  | 'backup.restore.fatal'
  // v2.23.3 (S-14): a mutation was refused because it would have removed
  // the last enabled, non-system global administrator. Operators need to
  // see these: a burst means someone is trying to lock the instance out.
  | 'admin.last_admin_protected';

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

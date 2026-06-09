import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { X509Certificate, createPrivateKey, createPublicKey } from 'node:crypto';
import { InstanceSettingsService } from './instanceSettingsService.js';
import { securityAudit } from './securityAuditService.js';
import { Errors } from '../lib/errors.js';

const SERVER_KEY = 'taskhub.server';
const SSL_META_KEY = 'taskhub.ssl';

export interface TaskhubServerConfig {
  httpsEnabled: boolean;
  port: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface SslCertificateInfo {
  commonName: string | null;
  issuer: string | null;
  validFrom: string | null;
  validTo: string | null;
  status: 'missing' | 'valid' | 'expired' | 'expiring_soon';
  daysUntilExpiration: number | null;
  hasCertificate: boolean;
  hasPrivateKey: boolean;
  hasChain: boolean;
  httpsEnabled: boolean;
  updatedAt: string | null;
}

function certDir(): string {
  return process.env.CERT_DIR ?? '/app/certs';
}

function certPath(name: string): string {
  return join(certDir(), name);
}

function parseCn(subject: string): string | null {
  const m = /(?:^|\/)CN=([^/]+)/i.exec(subject);
  return m?.[1] ?? null;
}

function parseIssuerShort(issuer: string): string | null {
  const cn = parseCn(issuer);
  if (cn) return cn;
  const o = /(?:^|\/)O=([^/]+)/i.exec(issuer);
  return o?.[1] ?? issuer;
}

function certStatus(validTo: Date): { status: SslCertificateInfo['status']; days: number } {
  const days = Math.ceil((validTo.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
  if (days < 0) return { status: 'expired', days };
  if (days <= 30) return { status: 'expiring_soon', days };
  return { status: 'valid', days };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

export class TaskhubServerService {
  private readonly settings = new InstanceSettingsService();

  private async ensureCertDir(): Promise<void> {
    await mkdir(certDir(), { recursive: true, mode: 0o700 });
  }

  async getServerConfig(): Promise<TaskhubServerConfig> {
    const row = await this.settings.get(SERVER_KEY);
    const v = (row?.value ?? {}) as Partial<TaskhubServerConfig>;
    const port = Number(v.port);
    return {
      httpsEnabled: v.httpsEnabled === true,
      port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 80,
      updatedAt: row?.updatedAt.toISOString() ?? null,
      updatedBy: row?.updatedBy ?? null,
    };
  }

  async updateServerConfig(
    actorId: string,
    input: { port?: number; httpsEnabled?: boolean },
  ): Promise<{ config: TaskhubServerConfig; restartRequired: boolean }> {
    const current = await this.getServerConfig();
    const nextPort = input.port ?? current.port;
    if (!Number.isInteger(nextPort) || nextPort < 1 || nextPort > 65535) {
      throw Errors.badRequest('Port must be between 1 and 65535');
    }
    const nextHttps = input.httpsEnabled ?? current.httpsEnabled;
    const config: TaskhubServerConfig = {
      httpsEnabled: nextHttps,
      port: nextPort,
      updatedAt: new Date().toISOString(),
      updatedBy: actorId,
    };
    await this.settings.set(SERVER_KEY, config, actorId);
    if (nextPort !== current.port) {
      await securityAudit.log('server.port.changed', actorId, {
        previousPort: current.port,
        newPort: nextPort,
      });
    }
    if (nextHttps !== current.httpsEnabled) {
      await securityAudit.log('ssl.https.toggled', actorId, {
        enabled: nextHttps,
      });
    }
    return { config, restartRequired: true };
  }

  async getSslInfo(): Promise<SslCertificateInfo> {
    const server = await this.getServerConfig();
    const metaRow = await this.settings.get(SSL_META_KEY);
    const hasCertificate = await fileExists(certPath('certificate.pem'));
    const hasPrivateKey = await fileExists(certPath('private.key'));
    const hasChain = await fileExists(certPath('chain.pem'));

    if (!hasCertificate) {
      return {
        commonName: null,
        issuer: null,
        validFrom: null,
        validTo: null,
        status: 'missing',
        daysUntilExpiration: null,
        hasCertificate: false,
        hasPrivateKey,
        hasChain,
        httpsEnabled: server.httpsEnabled,
        updatedAt: metaRow?.updatedAt.toISOString() ?? null,
      };
    }

    try {
      const pem = await readFile(certPath('certificate.pem'), 'utf8');
      const cert = new X509Certificate(pem);
      const validTo = new Date(cert.validTo);
      const { status, days } = certStatus(validTo);
      return {
        commonName: parseCn(cert.subject),
        issuer: parseIssuerShort(cert.issuer),
        validFrom: cert.validFrom,
        validTo: cert.validTo,
        status,
        daysUntilExpiration: days,
        hasCertificate: true,
        hasPrivateKey,
        hasChain,
        httpsEnabled: server.httpsEnabled,
        updatedAt: metaRow?.updatedAt.toISOString() ?? null,
      };
    } catch {
      return {
        commonName: null,
        issuer: null,
        validFrom: null,
        validTo: null,
        status: 'missing',
        daysUntilExpiration: null,
        hasCertificate: true,
        hasPrivateKey,
        hasChain,
        httpsEnabled: server.httpsEnabled,
        updatedAt: metaRow?.updatedAt.toISOString() ?? null,
      };
    }
  }

  private async validateCertKeyPair(certPem: string, keyPem: string): Promise<void> {
    let cert: X509Certificate;
    try {
      cert = new X509Certificate(certPem);
    } catch {
      throw Errors.badRequest('Invalid certificate format');
    }
    let key;
    try {
      key = createPrivateKey(keyPem);
    } catch {
      throw Errors.badRequest('Invalid private key format');
    }
    if (!cert.checkPrivateKey(createPublicKey(key))) {
      throw Errors.badRequest('Certificate and private key do not match');
    }
    const { status } = certStatus(new Date(cert.validTo));
    if (status === 'expired') {
      throw Errors.badRequest('Certificate has already expired');
    }
  }

  async uploadCertificate(actorId: string, pem: string): Promise<SslCertificateInfo> {
    await this.ensureCertDir();
    const trimmed = pem.trim();
    if (!trimmed.includes('BEGIN CERTIFICATE')) {
      throw Errors.badRequest('Expected PEM-encoded X.509 certificate');
    }
    // Validate parseable
    new X509Certificate(trimmed);
    const keyExists = await fileExists(certPath('private.key'));
    if (keyExists) {
      const keyPem = await readFile(certPath('private.key'), 'utf8');
      await this.validateCertKeyPair(trimmed, keyPem);
    }
    await writeFile(certPath('certificate.pem'), trimmed + '\n', { mode: 0o600 });
    await this.settings.set(SSL_META_KEY, { lastUpload: 'certificate' }, actorId);
    await securityAudit.log('ssl.certificate.uploaded', actorId, {
      commonName: parseCn(new X509Certificate(trimmed).subject),
    });
    return this.getSslInfo();
  }

  async uploadPrivateKey(actorId: string, pem: string): Promise<{ info: SslCertificateInfo; restartRequired: boolean }> {
    await this.ensureCertDir();
    const trimmed = pem.trim();
    if (!trimmed.includes('BEGIN') || !trimmed.includes('PRIVATE KEY')) {
      throw Errors.badRequest('Expected PEM-encoded private key');
    }
    createPrivateKey(trimmed); // validate
    const certExists = await fileExists(certPath('certificate.pem'));
    if (certExists) {
      const certPem = await readFile(certPath('certificate.pem'), 'utf8');
      await this.validateCertKeyPair(certPem, trimmed);
    }
    await writeFile(certPath('private.key'), trimmed + '\n', { mode: 0o600 });
    await chmod(certPath('private.key'), 0o600);
    await this.settings.set(SSL_META_KEY, { lastUpload: 'private_key' }, actorId);
    await securityAudit.log('ssl.private_key.uploaded', actorId, {});
    const info = await this.getSslInfo();
    return { info, restartRequired: true };
  }

  async uploadChain(actorId: string, pem: string): Promise<SslCertificateInfo> {
    await this.ensureCertDir();
    const trimmed = pem.trim();
    if (!trimmed.includes('BEGIN CERTIFICATE')) {
      throw Errors.badRequest('Expected PEM-encoded certificate chain');
    }
    // Validate each cert in chain
    const blocks = trimmed.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
    if (!blocks?.length) throw Errors.badRequest('No certificates found in chain');
    for (const block of blocks) new X509Certificate(block);
    await writeFile(certPath('chain.pem'), trimmed + '\n', { mode: 0o600 });
    await this.settings.set(SSL_META_KEY, { lastUpload: 'chain' }, actorId);
    await securityAudit.log('ssl.chain.uploaded', actorId, { count: blocks.length });
    return this.getSslInfo();
  }
}

export const taskhubServerService = new TaskhubServerService();

import { api } from '@/lib/api';

export interface TaskhubServerConfig {
  httpsEnabled: boolean;
  port: number;
  activePort: number;
  updatedAt: string | null;
  updatedBy: string | null;
  restartRequired?: boolean;
}

export interface SslInfo {
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
  restartRequired?: boolean;
}

export async function getTaskhubServer(): Promise<TaskhubServerConfig> {
  return (await api.get<TaskhubServerConfig>('/settings/taskhub/server')).data;
}

export async function updateTaskhubServer(input: {
  port?: number;
  httpsEnabled?: boolean;
}): Promise<TaskhubServerConfig> {
  return (await api.put<TaskhubServerConfig>('/settings/taskhub/server', input)).data;
}

export async function getSslInfo(): Promise<SslInfo> {
  return (await api.get<SslInfo>('/settings/taskhub/ssl')).data;
}

export async function uploadSslCertificate(pem: string): Promise<SslInfo> {
  return (await api.post<SslInfo>('/settings/taskhub/ssl/certificate', { pem })).data;
}

export async function uploadSslPrivateKey(pem: string): Promise<SslInfo> {
  return (await api.post<SslInfo>('/settings/taskhub/ssl/private-key', { pem })).data;
}

export async function uploadSslChain(pem: string): Promise<SslInfo> {
  return (await api.post<SslInfo>('/settings/taskhub/ssl/chain', { pem })).data;
}

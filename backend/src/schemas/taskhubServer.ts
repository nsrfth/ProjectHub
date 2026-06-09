import { z } from 'zod';

export const taskhubServerConfigResponse = z.object({
  httpsEnabled: z.boolean(),
  port: z.number().int(),
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
  activePort: z.number().int(),
  restartRequired: z.boolean().optional(),
});

export const taskhubServerUpdateBody = z.object({
  port: z.number().int().min(1).max(65535).optional(),
  httpsEnabled: z.boolean().optional(),
});

export const sslInfoResponse = z.object({
  commonName: z.string().nullable(),
  issuer: z.string().nullable(),
  validFrom: z.string().nullable(),
  validTo: z.string().nullable(),
  status: z.enum(['missing', 'valid', 'expired', 'expiring_soon']),
  daysUntilExpiration: z.number().int().nullable(),
  hasCertificate: z.boolean(),
  hasPrivateKey: z.boolean(),
  hasChain: z.boolean(),
  httpsEnabled: z.boolean(),
  updatedAt: z.string().nullable(),
  restartRequired: z.boolean().optional(),
});

export const pemUploadBody = z.object({
  pem: z.string().min(32).max(512_000),
});

export type TaskhubServerUpdateBody = z.infer<typeof taskhubServerUpdateBody>;
export type PemUploadBody = z.infer<typeof pemUploadBody>;

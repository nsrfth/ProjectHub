import { z } from 'zod';
import { contactResponse } from './contacts.js';

// v1.90: correspondence (دبیرخانه) — per-project register of formal letters.

export const correspondenceDirectionEnum = z.enum(['INCOMING', 'OUTGOING', 'INTERNAL']);
export const correspondenceStatusEnum = z.enum(['DRAFT', 'SENT', 'RECEIVED', 'ARCHIVED']);
export const referralKindEnum = z.enum(['ACTION', 'INFO']);
export const referralStatusEnum = z.enum(['PENDING', 'HANDLED']);

export const createCorrespondenceBody = z.object({
  direction: correspondenceDirectionEnum,
  subject: z.string().min(1).max(500).trim(),
  body: z.string().max(50_000).nullable().optional(),
  // Required letter date — a UTC instant (the SPA sends a ShamsiDatePicker
  // value converted to a UTC-midnight ISO string). Backs the Jalali-year
  // numbering reset.
  letterDate: z.string().datetime(),
  status: correspondenceStatusEnum.optional(),
  senderId: z.string().nullable().optional(),
  recipientId: z.string().nullable().optional(),
});

export const updateCorrespondenceBody = z
  .object({
    direction: correspondenceDirectionEnum.optional(),
    subject: z.string().min(1).max(500).trim().optional(),
    body: z.string().max(50_000).nullable().optional(),
    letterDate: z.string().datetime().optional(),
    status: correspondenceStatusEnum.optional(),
    senderId: z.string().nullable().optional(),
    recipientId: z.string().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });

export const setStatusBody = z.object({
  status: correspondenceStatusEnum,
});

export const listCorrespondenceQuery = z.object({
  direction: correspondenceDirectionEnum.optional(),
  status: correspondenceStatusEnum.optional(),
  search: z.string().max(200).trim().optional(),
});

// Refer (ارجاع) a letter to one or more team members for ACTION or INFO.
export const referBody = z.object({
  targets: z
    .array(
      z.object({
        userId: z.string(),
        kind: referralKindEnum.default('ACTION'),
        note: z.string().max(2_000).trim().nullable().optional(),
      }),
    )
    .min(1)
    .max(50),
});

export const referralResponse = z.object({
  id: z.string(),
  correspondenceId: z.string(),
  userId: z.string(),
  userName: z.string().nullable(),
  kind: referralKindEnum,
  note: z.string().nullable(),
  status: referralStatusEnum,
  referredById: z.string().nullable(),
  createdAt: z.string(),
  handledAt: z.string().nullable(),
});

export const correspondenceResponse = z.object({
  id: z.string(),
  teamId: z.string(),
  projectId: z.string(),
  direction: correspondenceDirectionEnum,
  subject: z.string(),
  body: z.string().nullable(),
  letterDate: z.string().datetime(),
  jalaliYear: z.number().int(),
  sequence: z.number().int(),
  referenceNumber: z.string(),
  status: correspondenceStatusEnum,
  senderId: z.string().nullable(),
  recipientId: z.string().nullable(),
  sender: contactResponse.nullable(),
  recipient: contactResponse.nullable(),
  createdById: z.string().nullable(),
  referrals: z.array(referralResponse),
  senderName: z.string().nullable(),
  recipientName: z.string().nullable(),
  attachmentCount: z.number().int(),
  hasReferrals: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const correspondenceListResponse = z.array(correspondenceResponse);

export type CreateCorrespondenceBody = z.infer<typeof createCorrespondenceBody>;
export type UpdateCorrespondenceBody = z.infer<typeof updateCorrespondenceBody>;
export type SetStatusBody = z.infer<typeof setStatusBody>;
export type ListCorrespondenceQuery = z.infer<typeof listCorrespondenceQuery>;
export type ReferBody = z.infer<typeof referBody>;

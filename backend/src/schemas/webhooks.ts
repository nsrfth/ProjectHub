import { z } from 'zod';

// Webhook CRUD + delivery log shapes. secret comes in plaintext, gets
// encrypted server-side; never appears in any response — `hasSecret` does.

export const webhookCreateBody = z.object({
  name: z.string().min(1).max(120),
  url: z.string().url().max(2048),
  events: z.array(z.string().min(1).max(60)).min(1),
  active: z.boolean().default(true),
  // Optional — if omitted, the server generates one and returns it ONCE
  // in the create response.
  secret: z.string().min(8).max(256).optional(),
});

export const webhookUpdateBody = z.object({
  name: z.string().min(1).max(120).optional(),
  url: z.string().url().max(2048).optional(),
  events: z.array(z.string().min(1).max(60)).min(1).optional(),
  active: z.boolean().optional(),
  secret: z.string().min(8).max(256).optional(),
});

export const webhookResponse = z.object({
  id: z.string(),
  teamId: z.string(),
  name: z.string(),
  url: z.string(),
  events: z.array(z.string()),
  active: z.boolean(),
  // Boolean projection — the ciphertext stays in the DB.
  hasSecret: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const webhookCreatedResponse = webhookResponse.extend({
  // Raw secret surfaced exactly once at creation.
  rawSecret: z.string(),
});

export const webhookListResponse = z.object({
  items: z.array(webhookResponse),
});

export const webhookIdParams = z.object({
  teamId: z.string(),
  webhookId: z.string(),
});

export const webhookTestResponse = z.object({
  ok: z.boolean(),
  httpStatus: z.number().int().optional(),
  errorMessage: z.string().optional(),
});

export const webhookDeliveryResponse = z.object({
  id: z.string(),
  webhookId: z.string(),
  eventType: z.string(),
  payload: z.unknown(),
  status: z.enum(['PENDING', 'DELIVERED', 'FAILED']),
  attempt: z.number().int(),
  maxAttempts: z.number().int(),
  httpStatus: z.number().int().nullable(),
  errorMessage: z.string().nullable(),
  nextAttemptAt: z.string(),
  deliveredAt: z.string().nullable(),
  createdAt: z.string(),
});

export const webhookDeliveryListResponse = z.object({
  items: z.array(webhookDeliveryResponse),
});

export const webhookDeliveryQuery = z.object({
  limit: z.coerce.number().int().positive().max(200).default(50),
});

export type WebhookCreateBody = z.infer<typeof webhookCreateBody>;
export type WebhookUpdateBody = z.infer<typeof webhookUpdateBody>;
export type WebhookDeliveryQuery = z.infer<typeof webhookDeliveryQuery>;

import { api } from '@/lib/api';

export interface Webhook {
  id: string;
  teamId: string;
  name: string;
  url: string;
  events: string[];
  active: boolean;
  hasSecret: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookCreated extends Webhook {
  // Raw signing secret — surfaced once at creation time. Used by the
  // receiver to verify the X-TaskHub-Signature HMAC header.
  rawSecret: string;
}

export interface WebhookCreateInput {
  name: string;
  url: string;
  events: string[];
  active?: boolean;
  secret?: string;
}

export type WebhookUpdateInput = Partial<WebhookCreateInput>;

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  eventType: string;
  payload: unknown;
  status: 'PENDING' | 'DELIVERED' | 'FAILED';
  attempt: number;
  maxAttempts: number;
  httpStatus: number | null;
  errorMessage: string | null;
  nextAttemptAt: string;
  deliveredAt: string | null;
  createdAt: string;
}

export interface TestResult {
  ok: boolean;
  httpStatus?: number;
  errorMessage?: string;
}

export async function listWebhooks(teamId: string): Promise<{ items: Webhook[] }> {
  return (await api.get<{ items: Webhook[] }>(`/teams/${teamId}/webhooks`)).data;
}

export async function createWebhook(teamId: string, input: WebhookCreateInput): Promise<WebhookCreated> {
  return (await api.post<WebhookCreated>(`/teams/${teamId}/webhooks`, input)).data;
}

export async function updateWebhook(teamId: string, webhookId: string, input: WebhookUpdateInput): Promise<Webhook> {
  return (await api.patch<Webhook>(`/teams/${teamId}/webhooks/${webhookId}`, input)).data;
}

export async function deleteWebhook(teamId: string, webhookId: string): Promise<void> {
  await api.delete(`/teams/${teamId}/webhooks/${webhookId}`);
}

export async function testWebhook(teamId: string, webhookId: string): Promise<TestResult> {
  return (await api.post<TestResult>(`/teams/${teamId}/webhooks/${webhookId}/test`)).data;
}

export async function listDeliveries(
  teamId: string,
  webhookId: string,
  limit = 50,
): Promise<{ items: WebhookDelivery[] }> {
  return (
    await api.get<{ items: WebhookDelivery[] }>(`/teams/${teamId}/webhooks/${webhookId}/deliveries`, {
      params: { limit },
    })
  ).data;
}

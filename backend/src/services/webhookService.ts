import crypto from 'node:crypto';
import { prisma } from '../data/prisma.js';
import { Errors } from '../lib/errors.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { randomTokenHex } from '../lib/hashing.js';

// Webhook management + delivery.
//
// Delivery is async + polling-based: emit() inserts a WebhookDelivery row in
// status=PENDING with nextAttemptAt=now. The dispatcher (drainOnce, run on
// an interval by webhookDispatcher.ts) finds ready rows and POSTs them with
// an HMAC signature header. Failures back off exponentially up to maxAttempts.

const SIGNATURE_HEADER = 'X-TaskHub-Signature';
const EVENT_HEADER = 'X-TaskHub-Event';
const DELIVERY_HEADER = 'X-TaskHub-Delivery';
// Initial backoff in milliseconds. Each subsequent attempt doubles it,
// capped by `MAX_BACKOFF_MS`. Configurable here in one place rather than
// surfacing it as env yet — webhook tuning isn't admin-facing in Phase 3B.
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 30 * 60_000; // 30 min ceiling
const DEFAULT_MAX_ATTEMPTS = 5;
const HTTP_TIMEOUT_MS = 10_000;

export interface WebhookView {
  id: string;
  teamId: string;
  name: string;
  url: string;
  events: string[];
  active: boolean;
  // We surface a boolean so the UI can render "secret set" without ever
  // seeing the ciphertext. There's no path that exposes the raw secret —
  // not even at create time the second the user navigates away.
  hasSecret: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function toView(w: {
  id: string;
  teamId: string;
  name: string;
  url: string;
  events: string[];
  active: boolean;
  secretEnc: string;
  createdAt: Date;
  updatedAt: Date;
}): WebhookView {
  return {
    id: w.id,
    teamId: w.teamId,
    name: w.name,
    url: w.url,
    events: w.events,
    active: w.active,
    hasSecret: !!w.secretEnc,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  };
}

export interface WebhookCreateInput {
  name: string;
  url: string;
  events: string[];
  active?: boolean;
  // Optional explicit secret. When omitted, we generate one + return it
  // ONCE in the create response.
  secret?: string;
}

export interface WebhookUpdateInput {
  name?: string;
  url?: string;
  events?: string[];
  active?: boolean;
  secret?: string;
}

export class WebhookService {
  // ── CRUD ────────────────────────────────────────────────────────────
  async list(teamId: string): Promise<WebhookView[]> {
    const rows = await prisma.webhook.findMany({
      where: { teamId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toView);
  }

  async get(teamId: string, id: string): Promise<WebhookView> {
    const row = await prisma.webhook.findUnique({ where: { id } });
    if (!row || row.teamId !== teamId) throw Errors.notFound('Webhook not found');
    return toView(row);
  }

  async create(
    teamId: string,
    input: WebhookCreateInput,
  ): Promise<{ view: WebhookView; rawSecret: string }> {
    const rawSecret = input.secret ?? randomTokenHex(32);
    const row = await prisma.webhook.create({
      data: {
        teamId,
        name: input.name,
        url: input.url,
        events: input.events,
        active: input.active ?? true,
        secretEnc: encrypt(rawSecret),
      },
    });
    return { view: toView(row), rawSecret };
  }

  async update(teamId: string, id: string, input: WebhookUpdateInput): Promise<WebhookView> {
    const existing = await prisma.webhook.findUnique({ where: { id } });
    if (!existing || existing.teamId !== teamId) throw Errors.notFound('Webhook not found');
    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.url !== undefined) data.url = input.url;
    if (input.events !== undefined) data.events = input.events;
    if (input.active !== undefined) data.active = input.active;
    if (input.secret !== undefined && input.secret.length > 0) {
      data.secretEnc = encrypt(input.secret);
    }
    const row = await prisma.webhook.update({ where: { id }, data });
    return toView(row);
  }

  async delete(teamId: string, id: string): Promise<void> {
    const existing = await prisma.webhook.findUnique({ where: { id } });
    if (!existing || existing.teamId !== teamId) throw Errors.notFound('Webhook not found');
    await prisma.webhook.delete({ where: { id } });
  }

  async listDeliveries(teamId: string, webhookId: string, opts: { limit: number }) {
    const hook = await prisma.webhook.findUnique({ where: { id: webhookId } });
    if (!hook || hook.teamId !== teamId) throw Errors.notFound('Webhook not found');
    return prisma.webhookDelivery.findMany({
      where: { webhookId },
      orderBy: { createdAt: 'desc' },
      take: opts.limit,
    });
  }

  // ── Emission ────────────────────────────────────────────────────────
  // Drop a delivery into the queue for every active webhook in `teamId`
  // that subscribes to `eventType` (or to "*"). Best-effort: a DB failure
  // here must not block the underlying business mutation.
  async emit(teamId: string, eventType: string, payload: unknown): Promise<void> {
    try {
      const hooks = await prisma.webhook.findMany({
        where: { teamId, active: true },
      });
      const matching = hooks.filter(
        (h) => h.events.includes(eventType) || h.events.includes('*'),
      );
      if (matching.length === 0) return;
      await prisma.webhookDelivery.createMany({
        data: matching.map((h) => ({
          webhookId: h.id,
          eventType,
          payload: payload as never,
          nextAttemptAt: new Date(),
        })),
      });
    } catch {
      // Webhooks are observability + integration, not core. Don't propagate.
    }
  }

  // Run a single test delivery synchronously and return the result so the
  // admin sees pass/fail in the UI without waiting for the next poll.
  async testSend(
    teamId: string,
    webhookId: string,
  ): Promise<{ ok: boolean; httpStatus?: number; errorMessage?: string }> {
    const hook = await prisma.webhook.findUnique({ where: { id: webhookId } });
    if (!hook || hook.teamId !== teamId) throw Errors.notFound('Webhook not found');
    const payload = { type: 'webhook.test', deliveredAt: new Date().toISOString() };
    return this.deliverOnce(hook, 'webhook.test', payload, 'test-' + randomTokenHex(8));
  }

  // ── Dispatcher ──────────────────────────────────────────────────────
  // Pick up the next N ready deliveries, attempt each, update the row.
  // Returns how many it processed so the interval driver can adapt cadence.
  async drainOnce(limit = 10): Promise<number> {
    const now = new Date();
    const rows = await prisma.webhookDelivery.findMany({
      where: { status: 'PENDING', nextAttemptAt: { lte: now } },
      orderBy: { nextAttemptAt: 'asc' },
      take: limit,
      include: { webhook: true },
    });

    for (const row of rows) {
      const attemptNo = row.attempt + 1;
      const result = await this.deliverOnce(
        row.webhook,
        row.eventType,
        row.payload as unknown,
        row.id,
      );
      if (result.ok) {
        await prisma.webhookDelivery.update({
          where: { id: row.id },
          data: {
            status: 'DELIVERED',
            attempt: attemptNo,
            httpStatus: result.httpStatus ?? null,
            deliveredAt: new Date(),
            errorMessage: null,
          },
        });
        continue;
      }
      // Failed — either retry or give up.
      const giveUp = attemptNo >= row.maxAttempts;
      const backoff = Math.min(BASE_BACKOFF_MS * 2 ** (attemptNo - 1), MAX_BACKOFF_MS);
      await prisma.webhookDelivery.update({
        where: { id: row.id },
        data: {
          attempt: attemptNo,
          httpStatus: result.httpStatus ?? null,
          errorMessage: result.errorMessage ?? null,
          status: giveUp ? 'FAILED' : 'PENDING',
          nextAttemptAt: giveUp ? row.nextAttemptAt : new Date(Date.now() + backoff),
        },
      });
    }
    return rows.length;
  }

  // ── Internals ───────────────────────────────────────────────────────
  // Single best-effort POST to the webhook URL with HMAC + diagnostic
  // headers. Returns success + httpStatus or failure + errorMessage.
  private async deliverOnce(
    webhook: { id: string; url: string; secretEnc: string },
    eventType: string,
    payload: unknown,
    deliveryId: string,
  ): Promise<{ ok: boolean; httpStatus?: number; errorMessage?: string }> {
    const bodyText = JSON.stringify({
      event: eventType,
      deliveryId,
      data: payload,
    });
    const secret = decrypt(webhook.secretEnc);
    const signature = crypto.createHmac('sha256', secret).update(bodyText).digest('hex');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      const res = await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [SIGNATURE_HEADER]: `sha256=${signature}`,
          [EVENT_HEADER]: eventType,
          [DELIVERY_HEADER]: deliveryId,
        },
        body: bodyText,
        signal: controller.signal,
      });
      // 2xx is success; everything else queues a retry.
      if (res.status >= 200 && res.status < 300) {
        return { ok: true, httpStatus: res.status };
      }
      return { ok: false, httpStatus: res.status, errorMessage: `HTTP ${res.status}` };
    } catch (e) {
      const errorMessage = (e as Error).message || 'fetch failed';
      return { ok: false, errorMessage };
    } finally {
      clearTimeout(timer);
    }
  }
}

export const WEBHOOK_DEFAULT_MAX_ATTEMPTS = DEFAULT_MAX_ATTEMPTS;

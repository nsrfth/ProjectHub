import nodemailer, { type Transporter } from 'nodemailer';
import { loadEnv } from '../config/env.js';

// Singleton mail abstraction. Built lazily on first use so test runs that
// never send mail don't pay for transport setup, and so missing SMTP_FROM
// only errors when somebody actually tries to email.
//
// When SMTP_HOST is unset, isEnabled() returns false and sendMail() is a
// no-op (with a debug log). Callers always invoke it best-effort — every
// caller is in a code path where a missing email isn't a hard failure
// (verification + reset both still surface dev tokens in non-prod; TASK_DUE
// fan-out already tolerates per-recipient failure).

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

interface MailerLike {
  isEnabled(): boolean;
  sendMail(msg: MailMessage): Promise<{ accepted: boolean }>;
  // Resets the cached transport; tests use this between fixtures.
  reset(): void;
}

class RealMailer implements MailerLike {
  private transport: Transporter | null = null;
  private from: string | null = null;
  private enabled: boolean | null = null;

  private build(): void {
    const env = loadEnv();
    if (!env.SMTP_HOST) {
      this.enabled = false;
      return;
    }
    if (!env.SMTP_FROM) {
      throw new Error('SMTP_FROM is required when SMTP_HOST is set');
    }
    this.from = env.SMTP_FROM;
    this.transport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER && env.SMTP_PASS
        ? { user: env.SMTP_USER, pass: env.SMTP_PASS }
        : undefined,
    });
    this.enabled = true;
  }

  isEnabled(): boolean {
    if (this.enabled === null) this.build();
    return this.enabled === true;
  }

  async sendMail(msg: MailMessage): Promise<{ accepted: boolean }> {
    if (!this.isEnabled() || !this.transport || !this.from) {
      return { accepted: false };
    }
    try {
      await this.transport.sendMail({
        from: this.from,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
      });
      return { accepted: true };
    } catch {
      // Best-effort by design — surface the failure via the boolean and let
      // the caller log if they care, but never throw into the request path.
      return { accepted: false };
    }
  }

  reset(): void {
    this.transport = null;
    this.from = null;
    this.enabled = null;
  }
}

export const mailer: MailerLike = new RealMailer();

// Public URL helper. Falls back to first CORS origin so deployments that
// already configured CORS don't need to duplicate the URL. Returns null if
// nothing is configured — the link helpers below render bare paths in that
// case (a degraded but readable email).
export function publicAppUrl(): string | null {
  const env = loadEnv();
  if (env.PUBLIC_APP_URL) return env.PUBLIC_APP_URL.replace(/\/$/, '');
  const first = env.corsOrigins[0];
  if (first) return first.replace(/\/$/, '');
  return null;
}

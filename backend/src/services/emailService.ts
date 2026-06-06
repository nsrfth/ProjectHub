import { mailer, publicAppUrl } from '../lib/mailer.js';

// High-level email composers. Each method maps a domain event to a single
// outbound message. Keep the templates as plain strings here — there's no
// need for a template engine for three message types. If/when localised
// emails are needed (per-user languagePreference), branch inside each
// composer on the recipient's locale.

function appUrl(path: string): string {
  const base = publicAppUrl();
  return base ? `${base}${path}` : path;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const emailService = {
  async sendVerification(opts: { to: string; name: string; token: string }): Promise<void> {
    if (!mailer.isEnabled()) return;
    const url = appUrl(`/verify-email?token=${encodeURIComponent(opts.token)}`);
    const safeName = escapeHtml(opts.name);
    await mailer.sendMail({
      to: opts.to,
      subject: 'Verify your TaskHub email',
      text: [
        `Hi ${opts.name},`,
        '',
        'Confirm your email by opening this link:',
        url,
        '',
        'The link expires in 24 hours. If you did not create an account, ignore this email.',
      ].join('\n'),
      html: `<p>Hi ${safeName},</p>
<p>Confirm your email by clicking the button below:</p>
<p><a href="${escapeHtml(url)}" style="display:inline-block;background:#0f172a;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Verify email</a></p>
<p>Or copy this URL into your browser: <code>${escapeHtml(url)}</code></p>
<p style="color:#64748b;font-size:12px">The link expires in 24 hours. If you did not create an account, ignore this email.</p>`,
    });
  },

  async sendPasswordReset(opts: { to: string; name: string; token: string }): Promise<void> {
    if (!mailer.isEnabled()) return;
    const url = appUrl(`/reset-password?token=${encodeURIComponent(opts.token)}`);
    const safeName = escapeHtml(opts.name);
    await mailer.sendMail({
      to: opts.to,
      subject: 'Reset your TaskHub password',
      text: [
        `Hi ${opts.name},`,
        '',
        'A password reset was requested for this address. Open this link to choose a new password:',
        url,
        '',
        'The link expires in 1 hour. If you did not request a reset, ignore this email — nothing changes until the link is opened.',
      ].join('\n'),
      html: `<p>Hi ${safeName},</p>
<p>A password reset was requested for this address.</p>
<p><a href="${escapeHtml(url)}" style="display:inline-block;background:#0f172a;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Reset password</a></p>
<p>Or copy this URL: <code>${escapeHtml(url)}</code></p>
<p style="color:#64748b;font-size:12px">The link expires in 1 hour. If you did not request a reset, ignore this email — nothing changes until the link is opened.</p>`,
    });
  },

  async sendTaskDue(opts: {
    to: string;
    taskTitle: string;
    projectId: string;
    taskId: string;
    dueDate: Date;
  }): Promise<void> {
    if (!mailer.isEnabled()) return;
    const url = appUrl(`/projects/${opts.projectId}/tasks/${opts.taskId}`);
    const dueStr = opts.dueDate.toISOString().slice(0, 10);
    const safeTitle = escapeHtml(opts.taskTitle);
    await mailer.sendMail({
      to: opts.to,
      subject: `Task due ${dueStr}: ${opts.taskTitle}`,
      text: [
        `Task "${opts.taskTitle}" is due on ${dueStr}.`,
        '',
        `Open it: ${url}`,
      ].join('\n'),
      html: `<p>Task <strong>${safeTitle}</strong> is due on <strong>${dueStr}</strong>.</p>
<p><a href="${escapeHtml(url)}">Open task</a></p>`,
    });
  },
};

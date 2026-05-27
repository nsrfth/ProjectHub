import { z } from 'zod';

// Validate every env var at startup. Crashing now beats subtle runtime failures.
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().optional(),

  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),

  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECURE: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),

  CORS_ORIGINS: z.string().default(''),

  UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  UPLOAD_DIR: z.string().default('./uploads'),

  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  AUTH_RATE_LIMIT_WINDOW: z.string().default('1 minute'),

  // Symmetric key for at-rest encryption of sensitive integration secrets:
  // LDAP bind passwords (Phase 2A), TOTP shared secrets (2C), webhook secrets
  // (3B). Expected as 64 lowercase hex characters (32 bytes / 256 bits).
  // Optional at this layer so deployments not using any of those features
  // don't need to provision it; lib/crypto.ts throws on first use if absent.
  MASTER_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'MASTER_KEY must be 64 hex chars (32 bytes)')
    .optional(),

  // TASK_DUE scheduler — runs in-process via setInterval. Disabled by default
  // so tests + small dev runs don't spawn an unwanted background loop. Production
  // single-instance deploys can opt in with TASK_DUE_ENABLED=true. Multi-instance
  // deploys should disable it here and run the scheduler elsewhere to avoid
  // duplicate notifications.
  TASK_DUE_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  // How far in advance to notify, in hours.
  TASK_DUE_LEAD_HOURS: z.coerce.number().int().positive().default(24),
  // How often to scan the DB for newly-due tasks, in minutes.
  TASK_DUE_CHECK_INTERVAL_MIN: z.coerce.number().int().positive().default(15),

  // Webhook dispatcher (Phase 3B). Same opt-in shape as the TASK_DUE
  // scheduler — disabled by default so tests + small dev runs don't fire
  // outbound HTTP unexpectedly. Multi-instance deploys should turn this on
  // exactly once (or run the dispatcher elsewhere) to avoid double-delivery.
  WEBHOOK_DISPATCH_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  WEBHOOK_DISPATCH_INTERVAL_SEC: z.coerce.number().int().positive().default(5),
  WEBHOOK_DISPATCH_BATCH: z.coerce.number().int().positive().default(10),

  // Recurrence scheduler (Phase 4). Same opt-in shape. Disabled by default
  // so tests + dev runs don't materialise tasks unexpectedly. Multi-instance
  // deploys: enable on exactly one node.
  RECURRENCE_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  RECURRENCE_CHECK_INTERVAL_MIN: z.coerce.number().int().positive().default(60),

  // v1.14: outbound SMTP for verification + password reset + TASK_DUE emails.
  // Mailer is enabled iff SMTP_HOST is set; with no host, every sendMail()
  // call is a no-op (and the controllers still surface devReset/Verify tokens
  // in non-prod). Keeps tests + first-run dev hassle-free.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  // STARTTLS vs implicit TLS. true = SMTPS (port 465); false = plain or
  // upgrade via STARTTLS (port 587). Matches nodemailer's `secure` flag.
  SMTP_SECURE: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  // From-address on every outbound. Required when SMTP_HOST is set; enforced
  // by the mailer at first use, not here, so unrelated tests don't break.
  SMTP_FROM: z.string().optional(),
  // Public origin (no trailing slash). Used to build links in emails:
  //   ${PUBLIC_APP_URL}/reset-password?token=...
  //   ${PUBLIC_APP_URL}/verify-email?token=...
  //   ${PUBLIC_APP_URL}/projects/:id/tasks/:id (TASK_DUE)
  // Falls back to the first CORS_ORIGINS entry when unset.
  PUBLIC_APP_URL: z.string().url().optional(),

  // v1.16: optional "update available" check. When enabled the backend
  // calls https://api.github.com/repos/nsrfth/taskhub/releases/latest on
  // demand (admin-only endpoint) and caches the result for the configured
  // window. Default OFF — self-hosted convention is no outbound calls
  // without operator consent. The repo is hardcoded; forks that want a
  // different upstream should edit services/updateCheckService.ts.
  UPDATE_CHECK_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  // How long the cached "latest release" answer is reused before the next
  // GitHub call. Unauthenticated GitHub API is 60 req/hr/IP — 6 h keeps
  // a busy instance well under the limit even with multiple admin tabs.
  UPDATE_CHECK_CACHE_HOURS: z.coerce.number().positive().default(6),

  // v1.22: in-app self-upgrade. Backend POSTs to UPDATER_URL when an admin
  // clicks "Run upgrade now" on the About page. Disabled (admin endpoint
  // returns 503) when UPDATER_URL is unset — the standard config that ships
  // out of the box. Set UPDATER_URL = http://updater:9000 + UPDATER_TOKEN
  // = <long random string> and bring the `upgrade` profile up to enable.
  //
  // The z.preprocess coerces empty strings to undefined — docker-compose
  // substitutes unset .env vars as `""` which would otherwise trip the
  // .url() validator. Same shape we'd want for PUBLIC_APP_URL too, but
  // that has a default-via-CORS fallback already.
  UPDATER_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
  UPDATER_TOKEN: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),

  // v1.27: automatic Postgres backups. Same opt-in shape as the TASK_DUE /
  // WEBHOOK / RECURRENCE schedulers — disabled by default so tests + small
  // dev runs don't kick off pg_dump in the background. Multi-instance
  // deploys: enable on exactly one node. Period + retention are configured
  // by an admin in Settings → Backups (persisted to InstanceSetting), not
  // here — env only controls whether the scheduler ticks + where dumps land.
  BACKUP_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  // How often the scheduler wakes up to check whether a new backup is due.
  // The actual cadence is admin-configurable (e.g. every 24h); this is just
  // the tick granularity. Keep it small relative to the smallest allowed
  // interval (1h).
  BACKUP_CHECK_INTERVAL_MIN: z.coerce.number().int().positive().default(15),
  // Where dumps land inside the container. Mapped to the backups_data named
  // volume in docker-compose.yml so files survive container rebuilds.
  BACKUP_DIR: z.string().default('./backups'),
  // v1.28: maximum size of an admin-uploaded .dump. Generous default (2 GiB)
  // because dumps grow unpredictably + the upload endpoint is admin-only.
  // Overrides the global UPLOAD_MAX_BYTES which is sized for task attachments.
  BACKUP_UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(2 * 1024 * 1024 * 1024),
})
  // v1.30.2 (S-1): when the in-app self-upgrade plumbing is wired
  // (UPDATER_URL set), UPDATER_TOKEN MUST be a >=24-char string. Without
  // the token, the privileged updater sidecar refuses to start anyway, so
  // a non-empty UPDATER_URL with a missing/short token is misconfiguration
  // worth crashing the backend over rather than silently treating every
  // /upgrade call as 503.
  .superRefine((env, ctx) => {
    if (!env.UPDATER_URL) return;
    if (!env.UPDATER_TOKEN || env.UPDATER_TOKEN.length < 24) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['UPDATER_TOKEN'],
        message:
          'UPDATER_TOKEN must be set and at least 24 characters when UPDATER_URL is configured. ' +
          'Generate one with: openssl rand -base64 48',
      });
    }
  });

export type Env = z.infer<typeof envSchema> & { corsOrigins: string[] };

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${issues}`);
  }
  const corsOrigins = parsed.data.CORS_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  cached = { ...parsed.data, corsOrigins };
  return cached;
}

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

  PUBLIC_FORM_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),
  PUBLIC_FORM_RATE_LIMIT_WINDOW: z.string().default('1 minute'),

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
  // v2.5.36: online backup (Kopia). Optional — only set when the `backup`
  // compose profile runs. The backend uses these for a best-effort reachability
  // check + status readout in Settings → Backups. Repo password + Google
  // service-account stay server-side secrets (never in the app DB).
  KOPIA_SERVER_URL: z.string().url().optional(),
  KOPIA_SERVER_USERNAME: z.string().optional(),
  KOPIA_SERVER_PASSWORD: z.string().optional(),
  // v2.5.37: shared volume where the app writes the Kopia service-account key,
  // repo password, policy triggers, and reads status.json from the entrypoint.
  KOPIA_SECRETS_DIR: z.string().default('/app/kopia-secrets'),
  // v1.30.7 (S-11): SSRF allow-list for the webhook target guard.
  // Comma-separated host names that are EXEMPT from the private-IP /
  // loopback / link-local rejection. Default empty so a fresh install
  // can never be used as an SSRF probe. Operators with deliberate
  // internal receivers (a monitoring sidecar on the same VM, etc.)
  // list each host explicitly. The test suite sets `127.0.0.1` here
  // so the existing receiver-stub tests keep passing.
  WEBHOOK_ALLOWED_HOSTS: z.string().default(''),

  // --- v2.6 (Phase 0a): scheduled directory sync ------------------------
  // Evaluates DirectoryGroupMapping for EVERY user in a directory, not just
  // those who happen to log in. Login-time mapping (authService) is unchanged
  // and keeps working; this is the safety net for users who never sign in —
  // under unit-scoped assignment those users are otherwise unassignable.
  //
  // Same opt-in shape as the other schedulers: disabled by default so tests
  // and dev runs never walk a directory. Multi-instance deploys: enable on
  // exactly one node — the in-process overlap guard is per-process and gives
  // no cross-replica mutual exclusion.
  //
  // Per-directory opt-in ALSO required (Directory.syncEnabled). Both must be
  // true. See docs/DIRECTORY_SYNC.md.
  DIRECTORY_SYNC_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  // Daily by default. The job exists to propagate joiner/mover/leaver events,
  // whose real-world latency is already measured in days, and a full directory
  // walk is far more expensive than the minute-scale jobs above.
  DIRECTORY_SYNC_INTERVAL_MIN: z.coerce.number().int().positive().default(1440),
  // LDAP paged-results page size. Keep under Active Directory's MaxPageSize
  // (1000 by default) — exceeding it makes the server refuse the page.
  DIRECTORY_SYNC_PAGE_SIZE: z.coerce.number().int().positive().default(500),
  // Safety cap. A directory returning more than this aborts the run rather
  // than processing a set we may have only partially seen.
  DIRECTORY_SYNC_MAX_USERS: z.coerce.number().int().positive().default(10000),
  // Observation mode: run the full scan and conflict detection, write nothing.
  // Intended to be left ON in production for the first two weeks.
  DIRECTORY_SYNC_DRY_RUN: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  // Global-role demotion when no mapping grants one any more.
  //
  // DEFAULT FALSE, DELIBERATELY. Today a user who loses their ADMIN group is
  // never demoted (authService only writes globalRole when a mapping supplies
  // one), which is a real access-review gap. But turning revocation on makes a
  // bad baseDN, a userFilter typo, or an empty directory response capable of
  // demoting every administrator in one unattended run. Enable only after
  // reviewing dry-run output. A last-admin interlock applies regardless.
  DIRECTORY_SYNC_REVOKE_GLOBAL_ROLE: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  // Per-directory wall-clock budget. Exceeding it aborts that directory
  // (without writes) rather than letting one unreachable DC stall the run.
  DIRECTORY_SYNC_TIMEOUT_SEC: z.coerce.number().int().positive().default(300),

  // --- v2.6 (Phase 1C): unit-scoped assignment ---------------------------
  // When on, a supervisor may only assign work within their own unit plus
  // collaborators explicitly granted the project; `task.assign_any` holders
  // are unrestricted. Off by default — turning this on changes who can assign
  // whom, and the Phase 1 exit criteria require a two-week pilot on one team
  // before it goes wider.
  ACCESS_UNIT_SCOPE: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),

  // --- v2.6 (Phase 2): unified project-access grants ---------------------
  // Three positions, walked in order — never jump straight to `on`:
  //
  //   off   legacy resolution only. ProjectGroupGrant / ProjectTeamShare are
  //         authoritative. The new grant table is written but never read.
  //   dual  BOTH resolvers run on every check. The LEGACY answer is returned,
  //         so behaviour is unchanged; disagreements are logged as
  //         `access.divergence`. This is the observation window — the phase
  //         exit criteria require >=2 weeks with zero unexplained entries.
  //   on    the unified resolver is authoritative. Legacy tables are still
  //         written and still present, so `off` remains an instant rollback.
  //
  // That rollback only exists because the Phase 6 table drop is deferred. Do
  // not "clean up" the legacy write paths before Phase 6.
  ACCESS_UNIFIED_GRANTS: z.enum(['off', 'dual', 'on']).default('off'),

  // --- v2.8 (Phase 3): grant consent flow --------------------------------
  // When on, grants that cross a consent boundary are created PENDING and
  // must be accepted before they take effect (and before any legacy row is
  // dual-written):
  //   TEAM subject       -> accepted by a manager of the TARGET team
  //   GROUP/unit subject -> accepted by the unit's MANAGER, once per project
  // Own-team manager grants and COLLAB-group grants skip PENDING (consent
  // already lives on group membership); global ADMIN always has the imposed
  // path (D-5/D-7 register defaults). Off = every grant is created ACTIVE,
  // which is exactly the plan's Phase 3 rollback position.
  ACCESS_GRANT_CONSENT: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
})
  // v1.30.2 (S-1): when the in-app self-upgrade plumbing is wired
  // (UPDATER_URL set), UPDATER_TOKEN MUST be a >=24-char string. Without
  // the token, the privileged updater sidecar refuses to start anyway, so
  // a non-empty UPDATER_URL with a missing/short token is misconfiguration
  // worth crashing the backend over rather than silently treating every
  // /upgrade call as 503.
  .superRefine((env, ctx) => {
    if (env.UPDATER_URL) {
      if (!env.UPDATER_TOKEN || env.UPDATER_TOKEN.length < 24) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['UPDATER_TOKEN'],
          message:
            'UPDATER_TOKEN must be set and at least 24 characters when UPDATER_URL is configured. ' +
            'Generate one with: openssl rand -base64 48',
        });
      }
    }
    // The two JWT secrets MUST differ — the whole point of the separate refresh
    // namespace is that a leaked ACCESS secret can't be used to mint REFRESH
    // tokens. Equal secrets silently collapse that guarantee, so fail at boot.
    if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_REFRESH_SECRET'],
        message:
          'JWT_REFRESH_SECRET must differ from JWT_ACCESS_SECRET. ' +
          'Generate distinct values with: openssl rand -base64 48',
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

/** Test-only: allow rebuilding the app with different env vars mid-suite. */
export function resetEnvCacheForTests(): void {
  cached = null;
}

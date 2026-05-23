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

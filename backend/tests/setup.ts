// Shared test bootstrap. Loaded by vitest before any test module via
// `setupFiles` in vitest.config.ts. Centralizes the env defaults that every
// integration test needs so the per-file `beforeAll` blocks stay focused on
// fixtures.

// ─────────────────────────────────────────────────────────────────────────
// PRODUCTION-DB GUARD (v1.23)
//
// Every integration test calls prisma.user.deleteMany() (or equivalent) in
// its beforeEach hook. Running them against the production database wipes
// real users. Three separate incidents in v1.16 / v1.18 / v1.23 prove the
// `oops, I forgot to set DATABASE_URL` failure mode is real, not theoretical.
//
// Refuse to start the suite unless the DATABASE_URL clearly identifies a
// test database. Two accepted patterns:
//   (a) a `?...` querystring or DB name containing the word "test"
//   (b) port 5433 (the postgres-test container's exposed port)
//
// Operators running an unusual setup can bypass with TASKHUB_ALLOW_PROD_DB=1
// — explicit override beats silent wipe.
// ─────────────────────────────────────────────────────────────────────────
const dbUrl = process.env.DATABASE_URL ?? '';
const bypass = process.env.TASKHUB_ALLOW_PROD_DB === '1';
if (!bypass) {
  const looksLikeTest =
    dbUrl.includes('5433') ||
    /\/taskhub_test(\?|$)/i.test(dbUrl) ||
    /[?&]schema=test/i.test(dbUrl);
  if (!looksLikeTest) {
    // eslint-disable-next-line no-console
    console.error(
      '\n[tests/setup.ts] REFUSING TO RUN — DATABASE_URL does not look like a test database.\n' +
        `  Got: ${dbUrl.replace(/:[^:@]*@/, ':***@')}\n` +
        '  Integration tests call prisma.user.deleteMany() and will wipe whatever DB this points at.\n' +
        '  Either:\n' +
        '    1. Start the test container: docker compose --profile test up -d postgres-test\n' +
        '       Then set DATABASE_URL=postgresql://taskhub:taskhub@postgres-test:5432/taskhub_test?schema=public\n' +
        '       (or use port 5433 from the host).\n' +
        '    2. Bypass with TASKHUB_ALLOW_PROD_DB=1 if you are SURE.\n',
    );
    process.exit(2);
  }
}

// AUTH_RATE_LIMIT_MAX defaults to 10 in production env loading, which trips
// the integration suite the moment a single test file does >10 registrations.
// Bump it for the test process unless the runner already set one explicitly.
process.env.AUTH_RATE_LIMIT_MAX ??= '10000';
process.env.GLOBAL_RATE_LIMIT_MAX ??= '100000';

// JWT + cookie defaults so individual test files don't have to repeat them.
process.env.NODE_ENV ??= 'test';
process.env.JWT_ACCESS_SECRET ??= 'test_access_secret_at_least_32_chars_long_xx';
process.env.JWT_REFRESH_SECRET ??= 'test_refresh_secret_at_least_32_chars_long_x';
process.env.CORS_ORIGINS ??= 'http://localhost:5173';
process.env.COOKIE_SECURE ??= 'false';

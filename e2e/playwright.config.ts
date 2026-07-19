import { defineConfig, devices } from '@playwright/test';

// v2.6 (Phase 0b) — end-to-end smoke harness.
//
// This exists to gate Phase 2. That phase rewrites resolveProjectAccess, which
// is consulted on effectively every authenticated request, behind an
// off -> dual -> on flag. Integration tests cover the resolver in isolation;
// nothing today proves the *application* still works after the flag moves.
// Five flows through a real browser do.
//
// Deliberately small. A large e2e suite that nobody trusts is worse than five
// specs that always mean something — every flow here is one whose breakage
// would make the product unusable, and nothing else belongs.
//
// Runs against an ALREADY-RUNNING stack (see E2E_BASE_URL). It does not build
// or migrate: those are the deploy's job, and a harness that silently
// re-migrates can mask a broken migration.

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';

export default defineConfig({
  testDir: './tests',
  // Serial. The suite mutates shared server state (projects, tasks) against a
  // single database, exactly like the backend integration suite, which forces
  // a single fork for the same reason.
  fullyParallel: false,
  workers: 1,

  // No accidental .only reaching CI.
  forbidOnly: !!process.env.CI,
  // One retry in CI absorbs genuine network flake without hiding a real
  // regression — a test that only passes on retry still shows as flaky.
  retries: process.env.CI ? 1 : 0,

  timeout: 30_000,
  expect: { timeout: 10_000 },

  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : [['list']],

  use: {
    baseURL,
    // Artefacts only for failures — a green run should leave nothing behind.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // Staging and local dev both serve plain HTTP with self-signed or no certs.
    ignoreHTTPSErrors: true,
  },

  projects: [
    // Auth runs first and saves storage state; every other spec reuses it, so
    // the login flow is exercised exactly once instead of per-test.
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState: '.auth/user.json' },
      dependencies: ['setup'],
    },
  ],
});

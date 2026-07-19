import { test as setup, expect } from '@playwright/test';
import { STATE_FILE, credentials } from './fixtures.js';

// Runs once, before every other spec, and saves the authenticated browser
// state so the remaining specs start logged in.
//
// Why storageState works here even though the access token is never persisted:
// the SPA deliberately keeps the access token in axios module memory only
// (never localStorage, never context) to limit XSS blast radius. What DOES
// persist is `th_refresh`, an httpOnly cookie scoped to /api/auth. Playwright's
// storageState captures cookies, so a restored context has no access token but
// a valid refresh cookie — the axios refresh-on-401 interceptor mints a fresh
// access token on the first API call. That is the real production flow, so
// reusing state exercises refresh rather than bypassing it.

setup('authenticate', async ({ page }) => {
  const { email, password } = credentials();

  await page.goto('/login');

  // autocomplete is locale-independent; the visible label is i18n'd and the
  // placeholder is a translation key, so neither can be matched on.
  await page.locator('input[autocomplete="username"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.locator('form button[type="submit"]').click();

  // If the smoke account has 2FA enabled, the form swaps to a code step
  // instead of navigating. Fail with an explanation rather than a bare
  // 30-second timeout on a URL that was never going to change.
  const otp = page.locator('input[autocomplete="one-time-code"]');
  await Promise.race([
    page.waitForURL('**/dashboard', { timeout: 15_000 }).catch(() => undefined),
    otp.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => undefined),
  ]);

  if (await otp.isVisible().catch(() => false)) {
    throw new Error(
      'The e2e smoke account has two-factor authentication enabled. ' +
        'The harness cannot complete a TOTP challenge. Use a dedicated smoke ' +
        'account with 2FA disabled and set E2E_EMAIL / E2E_PASSWORD.',
    );
  }

  await expect(page).toHaveURL(/\/dashboard/);
  await page.context().storageState({ path: STATE_FILE });
});

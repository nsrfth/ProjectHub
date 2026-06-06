import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mailer, publicAppUrl } from '../../src/lib/mailer.js';

// Mailer behaviour without an actual SMTP server: with SMTP_HOST unset,
// every send is a no-op that returns { accepted: false }. publicAppUrl()
// prefers PUBLIC_APP_URL and falls back to the first CORS origin.

const PRESERVE = {
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_FROM: process.env.SMTP_FROM,
  PUBLIC_APP_URL: process.env.PUBLIC_APP_URL,
};

beforeEach(() => {
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_FROM;
  delete process.env.PUBLIC_APP_URL;
  // The env loader caches the parsed config — bust it so each test sees
  // a fresh value. Also reset the lazy transport state in the mailer.
  // Easiest cache-bust: reach into the loaded module's internals via
  // dynamic import after wiping the cache hint. We just reset the mailer
  // and reload env via direct require where needed.
  mailer.reset();
});

afterEach(() => {
  // Restore so cross-suite state doesn't bleed.
  process.env.SMTP_HOST = PRESERVE.SMTP_HOST;
  process.env.SMTP_FROM = PRESERVE.SMTP_FROM;
  process.env.PUBLIC_APP_URL = PRESERVE.PUBLIC_APP_URL;
  mailer.reset();
});

describe('mailer (no SMTP configured)', () => {
  it('isEnabled() is false when SMTP_HOST is unset', () => {
    // env cache is loaded once per process — but loadEnv() returns the cached
    // copy. Since the test process started without SMTP_HOST, the cached
    // value is already correct for this assertion.
    expect(mailer.isEnabled()).toBe(false);
  });

  it('sendMail() resolves with accepted=false and never throws', async () => {
    const r = await mailer.sendMail({ to: 'x@y', subject: 's', text: 't' });
    expect(r.accepted).toBe(false);
  });
});

describe('publicAppUrl()', () => {
  it('falls back to the first CORS origin (no trailing slash) when PUBLIC_APP_URL is unset', () => {
    // CORS_ORIGINS is set to http://localhost:5173 by tests/setup.ts.
    expect(publicAppUrl()).toBe('http://localhost:5173');
  });
});

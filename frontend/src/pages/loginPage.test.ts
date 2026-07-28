import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const loginSrc = readFileSync(resolve(__dirname, 'LoginPage.tsx'), 'utf8');
// Comment-free view, for assertions that would otherwise trip over prose that
// merely *names* a class (e.g. the note explaining why bg-surface is avoided).
const loginCode = loginSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const heroSrc = readFileSync(
  resolve(__dirname, '../components/ui/aether-flow-hero.tsx'),
  'utf8',
);
const en = JSON.parse(readFileSync(resolve(__dirname, '../i18n/en.json'), 'utf8')) as Record<
  string,
  string
>;
const fa = JSON.parse(readFileSync(resolve(__dirname, '../i18n/fa.json'), 'utf8')) as Record<
  string,
  string
>;

describe('LoginPage auth wiring', () => {
  it('keeps the two-step credentials → 2FA flow', () => {
    expect(loginSrc).toContain('signIn(email, password)');
    expect(loginSrc).toContain("result.kind === 'pending2fa'");
    expect(loginSrc).toContain('signInWith2fa(step.pendingToken, code)');
    expect(loginSrc).toContain("nav('/dashboard')");
  });

  it('keeps the 503 directory-outage message passthrough', () => {
    expect(loginSrc).toContain('err.response?.status === 503');
  });

  it('keeps the testbed credential helper behind VITE_TESTBED', () => {
    expect(loginSrc).toContain('VITE_TESTBED');
    expect(loginSrc).toContain("t('login.testbed.use')");
  });

  it('still has no public self-registration link (v1.30.11 / S-9)', () => {
    expect(loginSrc).not.toMatch(/\/register|signUp|login\.signup/i);
  });
});

describe('LoginPage on the Aether Flow backdrop', () => {
  it('renders the form inside the hero', () => {
    expect(loginSrc).toContain('AetherFlowHero');
    expect(loginSrc).toContain("from '@/components/ui/aether-flow-hero'");
  });

  // The canvas paints its own opaque dark background, so the theme tokens
  // (bg-surface / text-text / border-border) would render an unreadable
  // light-on-light card under the LIGHT family. Everything here is styled
  // for a dark surface explicitly.
  it('does not fall back to theme surface tokens on the dark canvas', () => {
    expect(loginCode).not.toMatch(/\bbg-surface\b/);
    expect(loginCode).not.toMatch(/\btext-text(-muted)?\b/);
    expect(loginCode).not.toMatch(/\bborder-border\b/);
  });

  it('keeps LTR-forced inputs for email and 2FA codes under RTL', () => {
    expect(loginCode.match(/dir="ltr"/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('translates every new string in both catalogues', () => {
    for (const key of ['login.badge', 'login.tagline']) {
      expect(en[key]).toBeTruthy();
      expect(fa[key]).toBeTruthy();
    }
  });
});

describe('ParticleField', () => {
  it('tears down the loop, observer, and listeners on unmount', () => {
    expect(heroSrc).toContain('cancelAnimationFrame');
    expect(heroSrc).toContain('observer.disconnect()');
    expect(heroSrc).toContain("window.removeEventListener('pointermove'");
    expect(heroSrc).toContain("document.removeEventListener('visibilitychange'");
  });

  it('honours prefers-reduced-motion and caps the particle count', () => {
    expect(heroSrc).toContain("'(prefers-reduced-motion: reduce)'");
    expect(heroSrc).toContain('Math.min(maxParticles');
  });

  it('stays click-through so the overlaid form keeps focus', () => {
    expect(heroSrc).toContain('pointer-events-none absolute inset-0');
  });
});
